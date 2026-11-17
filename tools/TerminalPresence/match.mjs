const clean = value => String(value ?? '').replace(/[\u200b-\u200f\u2060-\u206f]/gu, '').trim();
const badgeName = value => /^(?:(?:[\u2800-\u28ff]\s*)|(?:\[[ .!]+\] Action Required \|\s*))?[🔵🟠⚪🧡🤍]\s+([\p{L}\p{N}_-]+)$/u.exec(clean(value))?.[1];

/** A UI title is evidence of an open terminal, not cryptographic process identity. */
export function matchRoster(windows, sessions) {
  const agents = new Map();
  const unconfirmed = [];
  const seen = new Set();
  for (const win of windows) {
    const terminals = [];
    const tabs = [];
    for (const element of win.elements ?? []) {
      let name;
      if (win.app === 'Code') {
        if (element.role === 'Edit') {
          const title = /^Terminal \d+, (.+?)(?: Run the command:|$)/u.exec(clean(element.name))?.[1];
          if (title) name = badgeName(title);
          if (!name && /[🔵🟠⚪🧡🤍]/u.test(element.name)) {
            const key = `${win.hwnd}:unknown:${clean(element.name)}`;
            if (!seen.has(key)) unconfirmed.push({ name: clean(element.name), hwnd: win.hwnd, reason: 'unrecognized-terminal-label' });
            seen.add(key);
          }
        } else if (element.role === 'TabItem') {
          const candidate = badgeName(clean(element.name).replace(/, (?:Window \d+: )?Editor Group \d+$/u, ''));
          if (candidate) tabs.push(candidate);
        }
      } else if (element.role === 'TabItem') {
        name = badgeName(element.name);
        if (!name && /[🔵🟠⚪🧡🤍]/u.test(element.name)) {
          const key = `${win.hwnd}:unknown:${clean(element.name)}`;
          if (!seen.has(key)) unconfirmed.push({ name: clean(element.name), hwnd: win.hwnd, reason: 'unrecognized-terminal-label' });
          seen.add(key);
        }
      }
      if (name) terminals.push({ name, evidence: element.name });
    }
    for (const name of tabs) {
      if (!terminals.some(t => t.name === name)) {
        const key = `${win.hwnd}:tab:${name}`;
        if (!seen.has(key)) unconfirmed.push({ name, hwnd: win.hwnd, reason: 'terminal-control-not-observed' });
        seen.add(key);
      }
    }
    for (const terminal of terminals) {
      const key = `${win.hwnd}:${terminal.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const matches = sessions.filter(s => s.name === terminal.name);
      if (matches.length !== 1) {
        unconfirmed.push({ ...terminal, hwnd: win.hwnd, reason: matches.length ? 'ambiguous-board-name' : 'name-not-on-live-board' });
        continue;
      }
      const session = matches[0];
      const agent = agents.get(session.id) ?? { ...session, locations: [], identityEvidence: 'terminal-label-and-live-board-name' };
      agent.locations.push({ hwnd: win.hwnd, app: win.app, desktop: win.desktop, desktopId: win.desktopId, evidence: terminal.evidence });
      agents.set(session.id, agent);
    }
  }
  return { agents: [...agents.values()], unconfirmed };
}
