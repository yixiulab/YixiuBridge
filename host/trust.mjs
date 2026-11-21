// YixiuBridge — trust registry (local file, ~/.yixiubridge/trust.json).
// Pairing model (borrowed from the AgentLimb pattern, re-implemented):
//   * Copying the connection prompt in the side panel opens a 30-minute
//     intake window (POST /pair/start).
//   * The FIRST unknown AI client to initialize inside the window is trusted
//     automatically — no confirmation page, no pairing code.
//   * Trust is stored per client id (client name + version) and survives
//     restarts. Removing a client here revokes it.
//   * An expired or already-consumed window means "not authorized" — the user
//     just copies the prompt again. No config change, no restart.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const INTAKE_WINDOW_MS = 30 * 60 * 1000;

export class TrustRegistry {
  constructor(dataDir) {
    this.file = join(dataDir, 'trust.json');
    this.dataDir = dataDir;
    this.clients = {}; // clientId -> { name, kind, trustedAt }
    this.intake = { until: 0, consumedBy: null };
    this._loaded = false;
  }

  async load() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const raw = await readFile(this.file, 'utf8');
      const data = JSON.parse(raw);
      this.clients = data.clients || {};
      this.intake = data.intake || { until: 0, consumedBy: null };
    } catch (e) { /* first run — start empty */ }
    this._loaded = true;
    return this;
  }

  async _save() {
    await mkdir(this.dataDir, { recursive: true });
    await writeFile(this.file, JSON.stringify({ clients: this.clients, intake: this.intake }, null, 2));
  }

  isTrusted(clientId) {
    return !!this.clients[clientId];
  }

  intakeOpen() {
    return this.intake.until > Date.now() && !this.intake.consumedBy;
  }

  async openIntake() {
    this.intake = { until: Date.now() + INTAKE_WINDOW_MS, consumedBy: null };
    await this._save();
    return { until: this.intake.until };
  }

  // Returns { trusted, fresh } — fresh means "just trusted via this window".
  async checkOrTrust(clientId, name, kind) {
    if (!this._loaded) await this.load();
    if (this.isTrusted(clientId)) return { trusted: true, fresh: false };
    if (this.intakeOpen()) {
      this.clients[clientId] = { name: name || clientId, kind: kind || 'unknown', trustedAt: new Date().toISOString() };
      this.intake.consumedBy = clientId;
      await this._save();
      return { trusted: true, fresh: true };
    }
    return {
      trusted: false,
      error: 'not authorized — no open pairing window. In the YixiuBridge side panel click "复制连接提示词" to open a 30-minute window, then reconnect.',
    };
  }

  async revoke(clientId) {
    delete this.clients[clientId];
    await this._save();
  }

  listClients() {
    return Object.entries(this.clients).map(([id, c]) => ({ id, ...c }));
  }
}
