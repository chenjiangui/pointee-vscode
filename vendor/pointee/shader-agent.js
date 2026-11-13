// Pointee — shader agent.
//
// The only file of this extension that runs in the page's own JavaScript
// world. The content script lives in Chrome's isolated world, which shares the
// DOM but not the page's objects — it can see a <canvas>, and nothing of the
// WebGL context, programs or uniforms behind it. Tuning a shader needs those,
// so this agent is injected on demand (chrome.scripting, world: "MAIN") when
// Edit Mode selects a canvas, and talks back over window.postMessage.
//
// Two rules shape everything here:
//
// **Overrides are applied at draw time, not by rewriting the page's uniform
// calls.** The page keeps uploading its own values; just before each draw on
// the probed context, any overridden uniform is written through this agent's
// own getUniformLocation handles. That sidesteps WebGLUniformLocation identity
// entirely (locations the page cached before injection can never be mapped
// back to names), keeps the hook surface to useProgram + the draw calls, and
// behaves identically — overriding a page-driven u_time still freezes it.
//
// **The page must never be left worse than it was found.** Teardown writes
// every original value back and restores the wrapped prototype methods — but
// only when the slot still holds our wrapper; a page that wrapped after us
// gets a delegating no-op left in place rather than having its own wrapper
// torn off. And because an extension reload kills the isolated world without
// touching this one, the content script heartbeats while anything is
// overridden: ten silent seconds and the agent restores everything itself.
//
// Read barely, send nothing further: what leaves this file is uniform names,
// types and numeric values of the one probed program — over postMessage, to
// the content script, on demand. See PRIVACY.md.

(() => {
  "use strict";
  if (window.__pntShaderAgent) return; // resident from an earlier injection
  window.__pntShaderAgent = true;

  // file:// documents have an opaque origin ("null"), which postMessage
  // rejects as a target. The message never leaves this window either way.
  const TARGET = location.origin === "null" ? "*" : location.origin;

  const OBSERVE_MS_DEFAULT = 700;
  const DISCOVERY_SETTLE_MS = 300; // after the first draw, dominance needs only this
  const SAMPLE_FRAMES = 10; // classification window: ~10 frames of getUniform reads
  const DRIVEN_MIN_CHANGES = 2; // one moved sample is a coincidence; two is a loop
  const TICK_MS = 100; // the driven read-out stream, at most 10 Hz
  const DEADMAN_MS = 10000; // silence longer than this means the tool is gone
  const HEART_MS = 2000;

  // GLSL type → how it reads and how it writes. Everything not in this table —
  // samplers, matrices, bvec — is not offered as a control. The `-v` setters
  // take arrays, so scalars and vectors write through the same call shape.
  const GL_TYPES = {
    0x1406: { type: "float", comps: 1, setter: "uniform1fv" },
    0x8b50: { type: "vec2", comps: 2, setter: "uniform2fv" },
    0x8b51: { type: "vec3", comps: 3, setter: "uniform3fv" },
    0x8b52: { type: "vec4", comps: 4, setter: "uniform4fv" },
    0x1404: { type: "int", comps: 1, setter: "uniform1iv" },
    0x8b53: { type: "ivec2", comps: 2, setter: "uniform2iv" },
    0x8b54: { type: "ivec3", comps: 3, setter: "uniform3iv" },
    0x8b55: { type: "ivec4", comps: 4, setter: "uniform4iv" },
    0x1405: { type: "uint", comps: 1, setter: "uniform1uiv" },
    0x8dc6: { type: "uvec2", comps: 2, setter: "uniform2uiv" },
    0x8dc7: { type: "uvec3", comps: 3, setter: "uniform3uiv" },
    0x8dc8: { type: "uvec4", comps: 4, setter: "uniform4uiv" },
    0x8b56: { type: "bool", comps: 1, setter: "uniform1iv" },
  };

  const PROTOS = [];
  if (window.WebGLRenderingContext) PROTOS.push(WebGLRenderingContext.prototype);
  // WebGL2's prototype does not inherit WebGL1's methods — every hook goes on
  // both, or a WebGL2 page is simply invisible.
  if (window.WebGL2RenderingContext) PROTOS.push(WebGL2RenderingContext.prototype);
  const DRAW_METHODS = [
    "drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced",
    "drawRangeElements",
  ];

  // ===== Registry (context bookkeeping) =====
  // getContext and linkProgram are wrapped from the moment the agent exists:
  // injected at document_start by the opt-in deep-capture setting, that means
  // "from page load", which is what catches a shader drawn once and never
  // again. Injected lazily, it merely starts recording now — harmless, and the
  // same code either way. Nothing here is sent anywhere; the WeakMap dies with
  // the page.
  const knownContexts = new WeakMap(); // canvas → most recent webgl/webgl2 context

  const realGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (kind, ...rest) {
    const ctx = realGetContext.call(this, kind, ...rest);
    if (ctx && (kind === "webgl" || kind === "webgl2" || kind === "experimental-webgl")) {
      knownContexts.set(this, ctx);
    }
    return ctx;
  };

  for (const proto of PROTOS) {
    const realLink = proto.linkProgram;
    if (!realLink) continue;
    proto.linkProgram = function (program) {
      // Relinking invalidates every uniform location this agent holds for the
      // program — carrying on writing through them would be undefined
      // behaviour, so the session ends and the panel is told.
      if (session && program === session.program) {
        post("PNT_SHADER_GONE", { reason: "relink" });
        endSession(false);
      }
      return realLink.call(this, program);
    };
  }

  // ===== Draw hooks =====
  // Installed on the first probe, removed at teardown when the slot still
  // holds our wrapper. `inert` covers the other case: a page that wrapped
  // after us would lose its own wrapper if we restored, so ours stays and
  // simply delegates.
  let hooked = false;
  let inert = false;
  const savedDraw = new Map(); // proto → { name → original }
  // Our wrappers close over their originals; nothing else identifies them from
  // outside, so ownership is tracked the honest way — by keeping the reference.
  const ourWrappers = new WeakSet();

  function beforeDraw(gl) {
    if (inert || !session || gl !== session.gl || session.overrides.size === 0) return;
    if (gl.getParameter(gl.CURRENT_PROGRAM) !== session.program) return;
    for (const name of session.overrides.keys()) {
      const rec = session.uniforms.get(name);
      if (rec && rec.loc) gl[rec.setter](rec.loc, session.overrides.get(name));
    }
  }

  function observeDraw(gl) {
    if (inert || !session || !session.observing) return;
    if (gl.canvas !== session.canvas) return;
    session.gl = gl;
    const program = gl.getParameter(gl.CURRENT_PROGRAM);
    if (!program) return;
    session.drawCounts.set(program, (session.drawCounts.get(program) || 0) + 1);
    if (!session.firstDrawAt) session.firstDrawAt = performance.now();
  }

  function installDrawHooks() {
    if (hooked) { inert = false; return; }
    for (const proto of PROTOS) {
      const originals = {};
      for (const name of DRAW_METHODS) {
        const real = proto[name];
        if (!real) continue;
        originals[name] = real;
        const wrapper = function (...args) {
          observeDraw(this);
          beforeDraw(this);
          return real.apply(this, args);
        };
        ourWrappers.add(wrapper);
        proto[name] = wrapper;
      }
      savedDraw.set(proto, originals);
    }
    hooked = true;
    inert = false;
  }

  function removeDrawHooks() {
    if (!hooked) return;
    let stranded = false;
    for (const [proto, originals] of savedDraw) {
      for (const [name, real] of Object.entries(originals)) {
        // Only restore a slot we still own. If the page wrapped over us after
        // injection, restoring would tear the page's own wrapper off — so ours
        // stays in the chain and goes inert instead, delegating straight
        // through.
        if (ourWrappers.has(proto[name])) proto[name] = real;
        else if (proto[name] !== real) stranded = true;
      }
    }
    if (!stranded) {
      savedDraw.clear();
      hooked = false;
    }
    inert = stranded;
  }

  // ===== Session =====
  let session = null; // { nonce, canvas, gl, program, uniforms, overrides, ... }
  let lastBeat = 0;
  let heartTimer = 0;

  function post(type, payload) {
    window.postMessage({
      pnt: "shader", v: 1, nonce: session ? session.nonce : (payload && payload.nonce) || "",
      type, ...payload,
    }, TARGET);
  }

  function toArray(value) {
    if (typeof value === "boolean") return [value ? 1 : 0];
    if (typeof value === "number") return [value];
    if (value && typeof value.length === "number") return Array.from(value);
    return null;
  }

  function endSession(restore) {
    if (!session) return;
    if (restore && session.gl && !session.gl.isContextLost()) {
      for (const name of session.overrides.keys()) {
        const rec = session.uniforms.get(name);
        if (rec && rec.original) writeNow(rec, rec.original);
      }
    }
    if (session.rafId) cancelAnimationFrame(session.rafId);
    if (session.pollId) clearInterval(session.pollId);
    if (session.lostHandler && session.canvas) {
      session.canvas.removeEventListener("webglcontextlost", session.lostHandler);
    }
    session = null;
    if (heartTimer) { clearInterval(heartTimer); heartTimer = 0; }
  }

  // One immediate write, outside any draw: what makes a parameter move on a
  // static frame, and what puts originals back at restore. Reads and writes
  // need the program bound, so the page's binding is saved around it.
  function writeNow(rec, value) {
    const gl = session && session.gl;
    if (!gl || gl.isContextLost() || !rec.loc) return;
    const prev = gl.getParameter(gl.CURRENT_PROGRAM);
    if (prev !== session.program) gl.useProgram(session.program);
    gl[rec.setter](rec.loc, value);
    if (prev !== session.program) gl.useProgram(prev);
  }

  // ===== Probe =====

  function findMarkedCanvas(nonce) {
    for (const canvas of document.querySelectorAll("canvas[data-pnt-probe]")) {
      if (canvas.getAttribute("data-pnt-probe") === nonce) return canvas;
    }
    return null;
  }

  function beginProbe(msg) {
    endSession(true);
    const canvas = findMarkedCanvas(msg.nonce);
    if (!canvas) {
      post("PNT_SHADER_ERROR", { nonce: msg.nonce, ok: false, reason: "no-canvas" });
      return;
    }
    installDrawHooks();
    session = {
      nonce: msg.nonce,
      canvas,
      gl: null,
      program: null,
      uniforms: new Map(), // name → { name, type, comps, setter, loc, driven, original }
      overrides: new Map(), // name → number[]
      observing: true,
      drawCounts: new Map(),
      firstDrawAt: 0,
      watching: false,
      lastTickAt: 0,
      rafId: 0,
      pollId: 0,
      lostHandler: null,
      maxUniforms: Math.max(1, Math.min(256, msg.maxUniforms || 64)),
    };
    lastBeat = performance.now();
    if (!heartTimer) heartTimer = setInterval(checkHeart, HEART_MS);

    // A timer, not a rAF chain: an occluded tab suspends animation frames
    // entirely, and a probe that can never conclude would leave the panel
    // waiting on a canvas nobody can see. The draw hooks do the counting on
    // their own; this only has to notice when the window is over.
    const deadline = performance.now() + Math.max(100, Math.min(4000, msg.observeMs || OBSERVE_MS_DEFAULT));
    session.pollId = setInterval(() => {
      if (!session || !session.observing) return;
      const now = performance.now();
      const settled = session.firstDrawAt && now - session.firstDrawAt >= DISCOVERY_SETTLE_MS;
      if (now < deadline && !settled) return;
      clearInterval(session.pollId);
      session.pollId = 0;
      session.observing = false;
      finishDiscovery();
    }, 80);
  }

  function finishDiscovery() {
    // The dominant program is the one that drew this canvas most during the
    // window — a multi-pass renderer gets its heaviest pass, which is a
    // documented v1 limit rather than a guess presented as certainty.
    let program = null, best = 0;
    for (const [candidate, count] of session.drawCounts) {
      if (count > best) { program = candidate; best = count; }
    }
    let live = Boolean(program);

    if (!program) {
      // Nothing drew. A context recorded at page load (deep capture) or an
      // already-created one still answers read-only; asking getContext on a
      // canvas that truly has no context would create one, which is why this
      // is the last resort and only ever on the one canvas the user selected.
      const gl = knownContexts.get(session.canvas) ||
        realGetContext.call(session.canvas, "webgl2") ||
        realGetContext.call(session.canvas, "webgl");
      if (!gl || typeof gl.getParameter !== "function") {
        post("PNT_SHADER_ERROR", { ok: false, reason: "no-gl" });
        endSession(false);
        return;
      }
      session.gl = gl;
      program = gl.getParameter(gl.CURRENT_PROGRAM);
      if (!program) {
        post("PNT_SHADER_ERROR", { ok: false, reason: "no-program" });
        endSession(false);
        return;
      }
    }

    const gl = session.gl;
    if (gl.isContextLost()) {
      post("PNT_SHADER_ERROR", { ok: false, reason: "context-lost" });
      endSession(false);
      return;
    }
    session.program = program;
    session.live = live;

    // The full uniform inventory, through this agent's own location handles.
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) || 0;
    let truncated = false;
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(program, i);
      if (!info) continue;
      const shape = GL_TYPES[info.type];
      if (!shape || info.size > 1) continue; // samplers, matrices, arrays: not dials
      if (session.uniforms.size >= session.maxUniforms) { truncated = true; break; }
      const loc = gl.getUniformLocation(program, info.name);
      if (!loc) continue;
      const value = toArray(gl.getUniform(program, loc));
      if (!value) continue;
      session.uniforms.set(info.name, {
        name: info.name, type: shape.type, comps: shape.comps, setter: shape.setter,
        loc, value, peak: Math.max(...value.map(Math.abs)), changes: 0, driven: false,
        original: null,
      });
    }

    session.lostHandler = () => {
      post("PNT_SHADER_GONE", { reason: "context-lost" });
      endSession(false);
    };
    session.canvas.addEventListener("webglcontextlost", session.lostHandler);

    if (!live || session.uniforms.size === 0) {
      postInventory(false, truncated);
      return;
    }

    // Classification: a parameter holds still across frames, a driven value
    // moves on its own. Watching beats name lists — nothing here needs to know
    // that this page spells time "iTime". Sampling rides rAF for frame
    // alignment, with a timer backstop: a tab hidden mid-probe suspends
    // animation frames, and an inventory built from fewer samples still beats
    // a panel waiting on one that never comes.
    let frames = 0;
    let concluded = false;
    const conclude = () => {
      if (concluded || !session) return;
      concluded = true;
      clearTimeout(backstop);
      for (const rec of session.uniforms.values()) {
        rec.driven = rec.changes >= DRIVEN_MIN_CHANGES;
      }
      postInventory(true, truncated);
    };
    const sample = () => {
      if (!session || concluded) return;
      frames++;
      for (const rec of session.uniforms.values()) {
        const now = toArray(gl.getUniform(session.program, rec.loc));
        if (!now) continue;
        if (now.some((v, i) => v !== rec.value[i])) rec.changes++;
        rec.value = now;
        rec.peak = Math.max(rec.peak, ...now.map(Math.abs));
      }
      if (frames < SAMPLE_FRAMES) {
        session.rafId = requestAnimationFrame(sample);
        return;
      }
      conclude();
    };
    const backstop = setTimeout(conclude, 1500);
    session.rafId = requestAnimationFrame(sample);
  }

  function postInventory(live, truncated) {
    post("PNT_SHADER_INVENTORY", {
      ok: true,
      contextType: (window.WebGL2RenderingContext &&
        session.gl instanceof WebGL2RenderingContext) ? "webgl2" : "webgl",
      live,
      truncated: Boolean(truncated),
      uniforms: Array.from(session.uniforms.values(), (rec) => ({
        name: rec.name, type: rec.type, comps: rec.comps,
        value: rec.value, peak: rec.peak, driven: rec.driven,
      })),
    });
  }

  // ===== The driven read-out stream =====
  function watchLoop() {
    if (!session || !session.watching) return;
    const now = performance.now();
    if (now - session.lastTickAt >= TICK_MS) {
      session.lastTickAt = now;
      const values = {};
      let any = false;
      for (const rec of session.uniforms.values()) {
        if (!rec.driven || !session.gl || session.gl.isContextLost()) continue;
        const v = toArray(session.gl.getUniform(session.program, rec.loc));
        if (v) { values[rec.name] = v; any = true; }
      }
      if (any) post("PNT_SHADER_TICK", { values });
    }
    session.rafId = requestAnimationFrame(watchLoop);
  }

  // ===== The dead-man switch =====
  // The content script heartbeats every few seconds while Edit Mode holds a
  // probe. An extension reload kills that world silently; the page must not
  // stay frozen at whatever the last scrub left, so silence restores it.
  function checkHeart() {
    if (!session) return;
    if (performance.now() - lastBeat > DEADMAN_MS) {
      endSession(true);
      removeDrawHooks();
    }
  }

  // ===== Messages =====
  window.addEventListener("message", (e) => {
    if (e.source !== window) return;
    if (e.origin !== location.origin && !(e.origin === "null" && location.origin === "null")) return;
    const msg = e.data;
    if (!msg || msg.pnt !== "shader" || msg.v !== 1) return;

    if (msg.type === "PNT_SHADER_PROBE") {
      beginProbe(msg);
      return;
    }

    // Everything below acts on the current session only; a stale nonce is a
    // message from a selection that no longer exists.
    if (!session || msg.nonce !== session.nonce) return;
    lastBeat = performance.now();

    if (msg.type === "PNT_SHADER_SET") {
      const rec = session.uniforms.get(msg.name);
      const value = toArray(msg.value);
      if (!rec || !value || value.length !== rec.comps) return;
      if (!rec.original) {
        const original = toArray(session.gl.getUniform(session.program, rec.loc));
        rec.original = original || value.slice();
      }
      session.overrides.set(msg.name, value);
      writeNow(rec, value); // a parameter on a static frame moves right now
      return;
    }

    if (msg.type === "PNT_SHADER_CLEAR") {
      const rec = session.uniforms.get(msg.name);
      session.overrides.delete(msg.name);
      // A driven value is overwritten by the page next frame anyway; a
      // parameter needs its original put back by hand.
      if (rec && rec.original) writeNow(rec, rec.original);
      return;
    }

    if (msg.type === "PNT_SHADER_WATCH") {
      const on = Boolean(msg.on);
      if (on === session.watching) return;
      session.watching = on;
      if (session.rafId) cancelAnimationFrame(session.rafId);
      session.rafId = on ? requestAnimationFrame(watchLoop) : 0;
      return;
    }

    if (msg.type === "PNT_SHADER_KEEPALIVE") return; // lastBeat already moved

    if (msg.type === "PNT_SHADER_TEARDOWN") {
      endSession(true);
      removeDrawHooks();
    }
  });
})();
