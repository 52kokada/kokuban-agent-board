'use strict';
const vscode = require('vscode');
const { claim, failed, validate, terminalOptions } = require('./launch.cjs');
const pending = new Set();
exports.activate = context => {
  context.subscriptions.push(vscode.window.registerUriHandler({
    async handleUri(uri) {
      const grant = new URLSearchParams(uri.query).get('grant');
      if (uri.path !== '/launch' || !/^[a-f0-9]{64}$/.test(grant || '') || pending.has(grant)) return;
      pending.add(grant);
      let received = false, created = false;
      try {
        const data = await claim(grant); received = true;
        const plan = validate(data);
        const terminal = vscode.window.createTerminal(terminalOptions(plan));
        created = true;
        terminal.show(false);
        await terminal.processId;
      } catch (error) { if (received && !created) { try { await failed(grant); } catch {} } await vscode.window.showErrorMessage('黒板: セッションを開けませんでした。' + error.message); }
      finally { pending.delete(grant); }
    }
  }));
};
