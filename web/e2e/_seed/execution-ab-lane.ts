// Stage A/B browser lane (AT-12 / AT-16 browser outcomes): a REAL supervisor
// (production boot, mock ACP adapter) behind a web server. Ports are fixed so
// the web server's `MAISTER_SUPERVISOR_URL` can be set before global setup
// starts the supervisor, and distinct from the stub (7788) and live (7777)
// lanes so the three can never answer each other's requests.
export const EXECUTION_AB_WEB_PORT = 3102;
export const EXECUTION_AB_SUPERVISOR_PORT = 7797;
export const EXECUTION_AB_SUPERVISOR_URL = `http://127.0.0.1:${EXECUTION_AB_SUPERVISOR_PORT}`;
