import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 目前請求所屬的模組 API context（P0-8 runtime wrapper 設定）。
 *
 * 刻意放在獨立、零依賴的檔案，避免 `firebase-admin` 與 `dal` 互相 import 造成循環。
 */
export interface ModuleRuntimeContext {
  moduleValue: string;
  pathname: string;
  method: string;
}

const storage = new AsyncLocalStorage<ModuleRuntimeContext>();

export function currentModuleValue(): string | null {
  return storage.getStore()?.moduleValue ?? null;
}

export function currentModuleContext(): ModuleRuntimeContext | null {
  return storage.getStore() ?? null;
}

export function runWithModuleContext<T>(context: ModuleRuntimeContext, fn: () => T): T {
  return storage.run(context, fn);
}
