// YixiuBridge — mock Gemini page (fake DOM) for adapter + protocol tests.
// Mirrors the DOM shape the adapter expects: a contenteditable prompt box,
// a Send button, and a streaming model response that finishes (stop button
// disappears). Streaming is simulated with real timers so the adapter's
// polling/completion logic is exercised for real.
//
// Usage:
//   const page = createMockGeminiPage({ chunks, chunkMs });
//   const adapter = createAdapter(page.doc, { win: page.win, pollMs: 20, stableMs: 40 });
//   await adapter.ask('hello');
import { FakeDocument, FakeElement, FakeWindow } from './fake-dom.mjs';

export function createMockGeminiPage({ chunks = ['4', ' is ', 'the answer.'], chunkMs = 10, boxKind = 'contenteditable' } = {}) {
  const doc = new FakeDocument();
  const win = new FakeWindow();

  const app = new FakeElement('div', { class: 'app' });
  doc.body.appendChild(app);

  // Prompt box.
  let box;
  if (boxKind === 'contenteditable') {
    box = new FakeElement('div', { contenteditable: 'true', 'aria-label': 'Ask Gemini' });
  } else {
    box = new FakeElement('textarea', { 'aria-label': 'Ask Gemini', placeholder: 'Ask Gemini' });
  }
  app.appendChild(box);

  // Send button: clicking starts the simulated streaming response.
  const send = new FakeElement('button', { 'aria-label': 'Send message' });
  app.appendChild(send);

  // Conversation container + response element (created on send).
  const convo = new FakeElement('div', { 'data-test-id': 'conversation' });
  app.appendChild(convo);

  let stopBtn = null;
  let responseEl = null;

  send.addEventListener('click', () => {
    responseEl = new FakeElement('div', { class: 'model-response-text' });
    convo.appendChild(responseEl);
    stopBtn = new FakeElement('button', { 'aria-label': 'Stop generating' });
    app.appendChild(stopBtn);
    let i = 0;
    const step = () => {
      if (i < chunks.length) {
        responseEl.textContent += chunks[i];
        i++;
        setTimeout(step, chunkMs);
      } else if (stopBtn) {
        stopBtn.remove();
        stopBtn = null;
      }
    };
    setTimeout(step, chunkMs);
  });

  return {
    doc, win, box, send, convo,
    get responseEl() { return responseEl; },
    get stopBtn() { return stopBtn; },
  };
}
