import { test } from "node:test";
import assert from "node:assert/strict";
import { sourceModule } from "./helpers.mjs";
const { CDPClient } = await sourceModule("src/cdp.ts");

function transport() {
  let receive;
  let close;
  const sent = [];
  return {
    sent,
    onDidReceiveMessage: listener => { receive = listener; return { dispose() {} }; },
    onDidClose: listener => { close = listener; return { dispose() {} }; },
    sendMessage: async message => { sent.push(message); },
    close: async () => close(),
    receive: message => receive(message),
  };
}
test("CDP correlates out-of-order replies and scoped events", async () => {
  const channel = transport();
  const client = new CDPClient(channel);
  client.pageSessionId = "page";
  const a = client.send("Runtime.enable");
  const b = client.send("Page.enable");
  assert.equal(channel.sent[0].sessionId, "page");
  channel.receive({ id: 2, result: { b: 2 } });
  channel.receive(JSON.stringify({ id: 1, result: { a: 1 } }));
  assert.deepEqual(await a, { a: 1 });
  assert.deepEqual(await b, { b: 2 });
  let event;
  client.onEvent(value => { event = value; });
  channel.receive({ method: "Page.loadEventFired", params: { timestamp: 10 }, sessionId: "page" });
  assert.equal(event.sessionId, "page");
  await client.dispose();
});
test("CDP rejects errors, timeouts, closed sessions and send failures", async () => {
  const channel = transport();
  const client = new CDPClient(channel, 20);
  const error = client.send("Bad.method");
  channel.receive({ id: 1, error: { message: "unsupported" } });
  await assert.rejects(error, /unsupported/);
  await assert.rejects(client.send("Never.replies"), /timed out/);
  const waiting = client.send("Waiting");
  await client.dispose();
  await assert.rejects(waiting, /closed/);
  await assert.rejects(client.send("After.close"), /closed/);
  const failed = new CDPClient({ ...transport(), sendMessage: async () => { throw new Error("transport failed"); } });
  await assert.rejects(failed.send("Runtime.enable"), /transport failed/);
  await failed.dispose();
});
test("CDP evaluate propagates page exceptions", async () => {
  const channel = transport();
  const client = new CDPClient(channel);
  const result = client.evaluate("throw Error()");
  channel.receive({ id: 1, result: { exceptionDetails: { exception: { description: "Error: page" } } } });
  await assert.rejects(result, /Error: page/);
  await client.dispose();
});
