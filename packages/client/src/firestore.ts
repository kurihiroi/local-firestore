import type { Firestore } from "./types.js";
import { HttpTransport } from "./transport.js";

export interface FirestoreSettings {
  host?: string;
  port?: number;
  ssl?: boolean;
}

const DEFAULT_SETTINGS: Required<FirestoreSettings> = {
  host: "localhost",
  port: 8080,
  ssl: false,
};

export function getFirestore(settings?: FirestoreSettings): Firestore {
  const config = { ...DEFAULT_SETTINGS, ...settings };
  const transport = new HttpTransport(config.host, config.port, config.ssl);
  return {
    type: "firestore",
    _transport: transport,
  };
}
