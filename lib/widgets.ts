export type ObservatoryWidgetSpec = globalThis.WidgetSpec;
export type ObservatoryTreeNode = globalThis.TreeNode;

export function row(...children: ObservatoryWidgetSpec[]): ObservatoryWidgetSpec {
  return { kind: "row", children, wrap: false };
}

export function wrappingRow(...children: ObservatoryWidgetSpec[]): ObservatoryWidgetSpec {
  return { kind: "row", children, wrap: true };
}

export function col(...children: ObservatoryWidgetSpec[]): ObservatoryWidgetSpec {
  return { kind: "col", children };
}

export function raw(entries: TextPropertyEntry[], key?: string): ObservatoryWidgetSpec {
  return { kind: "raw", entries, ...(key ? { key } : {}) };
}

export function button(
  label: string,
  key: string,
  options: { disabled?: boolean; primary?: boolean } = {},
): ObservatoryWidgetSpec {
  return {
    kind: "button",
    label,
    key,
    focused: false,
    intent: options.primary ? "primary" : "normal",
    disabled: options.disabled ?? false,
    focusable: true,
    bare: false,
    fullWidth: false,
  };
}

export function divider(): ObservatoryWidgetSpec {
  return { kind: "divider", ch: "─" };
}

export function tree(options: {
  nodes: ObservatoryTreeNode[];
  itemKeys?: string[];
  selectedIndex?: number;
  expandedKeys?: string[];
  key: string;
}): ObservatoryWidgetSpec {
  return {
    kind: "tree",
    nodes: options.nodes,
    itemKeys: options.itemKeys ?? [],
    selectedIndex: options.selectedIndex ?? 0,
    expandedKeys: options.expandedKeys ?? options.itemKeys ?? [],
    checkable: false,
    itemHeight: 1,
    cardBorders: false,
    indentCols: 1,
    key: options.key,
  };
}

export function list(
  items: TextPropertyEntry[],
  key: string,
  selectedIndex = 0,
): ObservatoryWidgetSpec {
  return {
    kind: "list",
    items,
    itemKeys: items.map((_, index) => `${key}:${index}`),
    selectedIndex,
    focusable: true,
    key,
  };
}

/** Mutations for a one-shot expansion action that returns focus to the tree. */
export function treeExpansionAction(
  widgetKey: string,
  expandedKeys: string[],
): globalThis.WidgetMutation[] {
  return [
    { kind: "setExpandedKeys", widgetKey, keys: expandedKeys },
    { kind: "setFocusKey", widgetKey },
  ];
}

export function hintBar(entries: HintEntry[]): ObservatoryWidgetSpec {
  return { kind: "hintBar", entries };
}
