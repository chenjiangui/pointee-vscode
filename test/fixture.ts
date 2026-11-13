export const fixture = `<!doctype html>
<html><head><meta charset="utf-8"><title>Pointee Fixture</title>
<style nonce="fixture">
  :root { --space-md: 16px; --space-lg: 24px; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px system-ui; color: #24292f; background: #f6f8fa; }
  header { padding: 24px; border-bottom: 1px solid #d0d7de; background: white; }
  h1 { margin: 0; font-size: 24px; letter-spacing: 0; }
  main { display: flex; flex-wrap: wrap; gap: 24px; padding: 40px 24px; }
  article { width: 280px; min-height: 160px; padding: var(--space-md); background: white; border: 1px solid #d0d7de; border-radius: 6px; }
  #target { background: #21865b; color: white; }
  #target span { display: block; margin-top: 16px; font-size: 14px; }
  button { padding: 8px; }
  .spacer { height: 900px; }
  #below { margin: 40px; width: 240px; height: 120px; min-height: 0; background: #ca3547; color: white; }
  #tall { margin: 24px; width: 200px; height: 1000px; }
  #tall div { height: 500px; background: #ca3547; }
  #tall div + div { background: #169ee8; }
</style></head>
<body>
<header><h1>Element workspace</h1></header>
<main id="cards">
  <h2>Plans</h2>
  <article id="target" data-testid="plan-card" data-source-loc="src/components/PlanCard.tsx:42:6">Pro Plan<span>For teams that need more.</span></article>
  <article id="neighbor">Team Plan</article>
  <article id="price:pro/2026" data-testid='quote&quot;slash&#92;value'>Special selector</article>
  <article>Repeated</article><article>Repeated</article>
</main>
<div class="spacer"></div><article id="below">Below the viewport</article>
<section id="tall"><div></div><div></div></section>
<script nonce="fixture">
  window.pageClicks = 0;
  document.getElementById("target").addEventListener("click", () => window.pageClicks++);
  window.pageChrome = window.chrome;
  const glCanvas = document.createElement("canvas");
  glCanvas.id = "webgl"; glCanvas.width = 100; glCanvas.height = 80;
  document.getElementById("neighbor").append(glCanvas);
  const gl = glCanvas.getContext("webgl");
  if (gl) { gl.clearColor(0.1, 0.6, 0.9, 1); gl.clear(gl.COLOR_BUFFER_BIT); }
</script></body></html>`;
