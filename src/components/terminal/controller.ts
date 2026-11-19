import type { InjectionKey, Ref } from "vue";
import type { TerminalProfileInfo } from "../../terminalClient";

/** What a pane can do in its Terminal app (provided by TerminalView). */
export interface TerminalController {
  fontSize: Ref<number>;
  /** Pane ids that are on screen (their tab is the active one). */
  visible: (paneId: string) => boolean;
  focused: (paneId: string) => boolean;
  profileOf: (profileId: string) => TerminalProfileInfo | undefined;
  focus: (paneId: string) => void;
  title: (paneId: string, title: string) => void;
  pinFolder: (paneId: string, path: string) => void;
  activity: (paneId: string) => void;
  bell: (paneId: string) => void;
  /** Close a standalone tab after a clean shell exit, keeping split layouts intact. */
  closeAfterExit: (paneId: string) => boolean;
  command: (name: string, paneId: string) => void;
  /** Panes register their element and actions for focus moves and search. */
  register: (paneId: string, pane: PaneHandle | null) => void;
}
export interface PaneHandle {
  element: HTMLElement;
  focus(): void;
  find(query: string, options: { caseSensitive: boolean; backwards: boolean }): boolean;
  clearFind(): void;
  copy(): void;
  paste(): void;
  clear(): void;
  restart(): void;
}
export const TERMINAL: InjectionKey<TerminalController> = Symbol("terminal");
