/**
 * 功能入口卡片的名稱處理。
 *
 * 不同作者可能各自寫出同名功能（例如兩個「自主學習計畫」）。
 * 只有一個同名模組時維持乾淨名稱；兩個以上時才加作者名區分。
 * 若同一組內作者也相同，再補上模組代碼，避免兩張卡片仍同名。
 */
export interface ModuleCardLabelSource {
  value: string;
  label: string;
  author?: { author?: string };
}

export function moduleCardLabels(items: readonly ModuleCardLabelSource[]): string[] {
  const groups = new Map<string, ModuleCardLabelSource[]>();
  for (const item of items) {
    const group = groups.get(item.label) ?? [];
    group.push(item);
    groups.set(item.label, group);
  }

  const labels = new Map<ModuleCardLabelSource, string>();
  for (const [label, group] of groups) {
    if (group.length === 1) {
      labels.set(group[0], label);
      continue;
    }
    const authorKeys = group.map((item) => item.author?.author?.trim() || item.value);
    const authorCollision = new Set(authorKeys).size < authorKeys.length;
    group.forEach((item, index) => {
      labels.set(
        item,
        authorCollision
          ? `${label}（${authorKeys[index]}／${item.value}）`
          : `${label}（${authorKeys[index]}）`
      );
    });
  }

  return items.map((item) => labels.get(item) ?? item.label);
}
