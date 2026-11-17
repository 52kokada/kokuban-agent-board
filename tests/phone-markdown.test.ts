import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Script, createContext } from 'node:vm';
import { client, shell } from '../src/phone/shell.js';

class Node {
  children: (Node | string)[] = [];
  className = '';
  attributes: Record<string, string> = {};
  href = ''; target = ''; rel = '';
  classList = { add: (name: string) => { this.className += ' ' + name; } };
  constructor(public tag: string) {}
  get textContent(): string { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(text: string) { this.children = [text]; }
  append(...children: (Node | string)[]) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute(name: string, value: string) { this.attributes[name] = value; }
}
function render(text: string) {
  const n = new Node('div'); n.textContent = text;
  const context = createContext({ URL, document: { createElement: (tag: string) => new Node(tag) }, n });
  const names = ['el', 'linkify', 'markdownInline', 'markdownCells', 'markdown'];
  new Script(names.map(name => client.split('\n').find(line => line.startsWith(`function ${name}(`))).join('\n') + '\nmarkdown(n);').runInContext(context);
  return n;
}
function all(n: Node, tag: string): Node[] {
  return [ ...(n.tag === tag ? [n] : []), ...n.children.flatMap(c => typeof c === 'string' ? [] : all(c, tag)) ];
}

test('assistant Markdown renders paragraphs, emphasis, lists and code as semantic nodes', () => {
  const n = render('# Update\n\n**Strategy paper:** read *this*.\n\n- First\n- Second\n\n1. Open\n2. Review\n\n`literal <img>`\n\n```js\n<script>alert(1)</script>\n```');
  assert.equal(all(n, 'h2')[0].textContent, 'Update');
  assert.equal(all(n, 'strong')[0].textContent, 'Strategy paper:');
  assert.equal(all(n, 'em')[0].textContent, 'this');
  assert.equal(all(n, 'ul').length, 1); assert.equal(all(n, 'ol').length, 1);
  assert.equal(all(n, 'li').length, 4);
  assert.equal(all(n, 'code')[0].textContent, 'literal <img>');
  assert.equal(all(n, 'pre')[0].textContent, '<script>alert(1)</script>');
  assert.equal(all(n, 'script').length, 0); assert.equal(all(n, 'img').length, 0);
});

test('the screenshot table renders as a bounded table with headers and readable rows', () => {
  const n = render('| Thread | What they said | Your draft says |\n|---|---|---|\n| **Patrick (Econ)** | Equivalencies updated. | Thank you. |\n| Adviser | Requirements reviewed. | Ready to send. |');
  assert.equal(all(n, 'table').length, 1); assert.equal(all(n, 'th').length, 3);
  assert.equal(all(n, 'td').length, 6);
  assert.equal(all(n, 'strong')[0].textContent, 'Patrick (Econ)');
  assert.match(all(n, 'div').find(d => d.className === 'markdown-table')!.attributes['aria-label'], /Scroll horizontally/);
});

test('formatted and bare links preserve underscores and block executable protocols', () => {
  const n = render('[Paper](https://docs.google.com/document/d/a_b_c/edit?authuser=user%40example.edu)\n\nhttps://example.com/a_b_c\n\n[bad](javascript:alert(1)) [bad](data:text/html,test) <img src=x onerror=alert(1)>');
  const links = all(n, 'a'); assert.equal(links.length, 2);
  assert.equal(links[0].href, 'https://docs.google.com/document/d/a_b_c/edit?authuser=user%40example.edu');
  assert.equal(links[1].href, 'https://example.com/a_b_c');
  for (const a of links) { assert.equal(a.target, '_blank'); assert.equal(a.rel, 'noopener noreferrer'); }
  assert.equal(all(n, 'img').length, 0);
});

test('phone status bar declares both system themes and extends the app behind iOS chrome', () => {
  assert.match(shell, /name="theme-color" content="#1a1a1d" media="\(prefers-color-scheme: dark\)"/);
  assert.match(shell, /name="theme-color" content="#f5f5f7" media="\(prefers-color-scheme: light\)"/);
  assert.match(shell, /name="apple-mobile-web-app-status-bar-style" content="black-translucent"/);
  new Script(client);
});
