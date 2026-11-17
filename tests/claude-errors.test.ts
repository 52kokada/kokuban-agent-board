import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { claudeFailureDetail } from '../src/conversations/providers/claude-errors.js';

test('Claude failures retain actionable result diagnostics and assistant API errors', () => {
  assert.match(claudeFailureDetail({ errors: ['Rate limit exceeded'] }), /Rate limit exceeded/);
  assert.match(claudeFailureDetail({}, 'API Error: safeguards flagged this session. Details: [cyber]'), /safeguards flagged this session/);
  assert.match(claudeFailureDetail({ subtype: 'error_during_execution' }), /error_during_execution/);
  assert.ok(claudeFailureDetail({ errors: ['x'.repeat(20000)] }).length < 8100);
});
