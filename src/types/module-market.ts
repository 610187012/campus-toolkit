export type ModuleMarketStatus = "official" | "reviewed" | "experimental";

export interface ModuleMarketEntry {
  id: string;
  name: string;
  description: string;
  status?: ModuleMarketStatus;
  version: string;
  latestVersion?: string;
  minHostVersion?: string;
  repoUrl?: string;
  downloadUrl?: string;
  checksumSha256?: string;
  /** 選填：ed25519 簽章（base64）與作者公鑰（base64 SPKI）；主程式會比對釘選信任清單 */
  signature?: string;
  publicKey?: string;
  category?: string;
  tags?: string[];
  releaseNotes?: string[];
}

export interface ModuleMarketIndex {
  generatedAt?: string;
  marketplaceVersion?: string;
  modules: ModuleMarketEntry[];
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const arr = value
    .map((item) => readString(item))
    .filter((item): item is string => item !== null);
  return arr.length > 0 ? arr : undefined;
}

export function parseModuleMarketEntry(value: unknown): ModuleMarketEntry | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Record<string, unknown>;
  const id = readString(entry.id);
  const name = readString(entry.name);
  const version = readString(entry.version);

  if (!id || !name || !version) {
    return null;
  }

  const description = readString(entry.description) ?? "";
  const status =
    entry.status === "official" || entry.status === "reviewed" || entry.status === "experimental"
      ? entry.status
      : undefined;
  const repoUrl = readString(entry.repoUrl) ?? undefined;
  const downloadUrl = readString(entry.downloadUrl) ?? undefined;
  const checksumSha256 = readString(entry.checksumSha256) ?? undefined;
  const signature = readString(entry.signature) ?? undefined;
  const publicKey = readString(entry.publicKey) ?? undefined;
  const minHostVersion = readString(entry.minHostVersion) ?? undefined;
  const latestVersion = readString(entry.latestVersion) ?? version;

  return {
    id,
    name,
    description,
    status,
    version,
    latestVersion,
    minHostVersion,
    repoUrl,
    downloadUrl,
    checksumSha256,
    signature,
    publicKey,
    category: readString(entry.category) ?? undefined,
    tags: readStringArray(entry.tags),
    releaseNotes: readStringArray(entry.releaseNotes),
  };
}

export function parseModuleMarketIndex(value: unknown): ModuleMarketIndex | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const index = value as Record<string, unknown>;
  const rawModules = Array.isArray(index.modules) ? index.modules : [];
  const modules = rawModules
    .map((module) => parseModuleMarketEntry(module))
    .filter((module): module is ModuleMarketEntry => module !== null);

  return {
    generatedAt: readString(index.generatedAt) ?? undefined,
    marketplaceVersion: readString(index.marketplaceVersion) ?? undefined,
    modules,
  };
}
