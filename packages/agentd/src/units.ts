/** Service definitions that keep agentd running: systemd (Linux) and launchd (macOS). */

export function systemdUnit(opts: {
  node: string;
  script: string;
  user: string;
  envFile: string;
}): string {
  return `[Unit]
Description=Kovan agentd: runs Kovan's agents on this machine
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${opts.user}
EnvironmentFile=${opts.envFile}
ExecStart=${opts.node} ${opts.script}
Restart=always
RestartSec=10
# Stop politely: agentd pauses what it runs, with the reason.
KillSignal=SIGTERM
TimeoutStopSec=30
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
`;
}

export function launchdPlist(opts: {
  node: string;
  script: string;
  env: Record<string, string>;
  logDir: string;
}): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const env = Object.entries(opts.env)
    .map(([k, v]) => `      <key>${esc(k)}</key>\n      <string>${esc(v)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>dev.alperkayan.kovan.agentd</string>
    <key>ProgramArguments</key>
    <array>
      <string>${esc(opts.node)}</string>
      <string>${esc(opts.script)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${env}
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${esc(opts.logDir)}/agentd.log</string>
    <key>StandardErrorPath</key>
    <string>${esc(opts.logDir)}/agentd.log</string>
  </dict>
</plist>
`;
}
