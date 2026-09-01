/** Missing exports in Fresh 0.4.10's generated declaration bundle. */
type WindowId = number;

interface DualListOption {
  value: string;
  label: string;
}

interface CompletionItem {
  value: string;
  kind?: string;
}

interface BufferGroupResult {
  groupId: number;
  panels: Record<string, number>;
}
