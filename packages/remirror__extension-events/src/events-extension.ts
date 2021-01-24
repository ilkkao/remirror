import {
  CreateExtensionPlugin,
  EditorState,
  EditorStateProps,
  EditorView,
  EditorViewProps,
  entries,
  ErrorConstant,
  extension,
  ExtensionPriority,
  GetHandler,
  GetMarkRange,
  getMarkRange,
  Handler,
  Helper,
  helper,
  invariant,
  isString,
  MarkType,
  NodeType,
  NodeWithPosition,
  noop,
  PlainExtension,
  range,
  ResolvedPos,
} from '@remirror/core';

import { getPositionFromEvent } from './events-utils';

export interface EventsOptions {
  /**
   * Listens for blur events on the editor.
   *
   * Return `true` to prevent any other prosemirror listeners from firing.
   */
  blur?: Handler<(event: FocusEvent) => boolean | undefined | void>;

  /**
   * Listens for focus events on the editor.
   *
   * Return `true` to prevent any other prosemirror listeners from firing.
   */
  focus?: Handler<(event: FocusEvent) => boolean | undefined | void>;

  /**
   * Listens for mousedown events on the editor.
   *
   * Return `true` to prevent any other prosemirror listeners from firing.
   */
  mousedown?: Handler<(event: MouseEvent) => boolean | undefined | void>;

  /**
   * Listens for mouseup events on the editor.
   *
   * Return `true` to prevent any other prosemirror listeners from firing.
   */
  mouseup?: Handler<(event: MouseEvent) => boolean | undefined | void>;

  /**
   * Listens for mouseenter events on the editor.
   *
   * Return `true` to prevent any other prosemirror listeners from firing.
   */
  mouseenter?: Handler<(event: MouseEvent) => boolean | undefined | void>;

  /**
   * Listens for mouseleave events on the editor.
   *
   * Return `true` to prevent any other prosemirror listeners from firing.
   */
  mouseleave?: Handler<(event: MouseEvent) => boolean | undefined | void>;

  /**
   * Listens for click events and provides information which may be useful in
   * handling them properly.
   *
   * This can be used to check if a node was clicked on.
   *
   * Please note that this click handler may be called multiple times for one
   * click. Starting from the node that was clicked directly, it walks up the
   * node tree until it reaches the `doc` node.
   *
   * Return `true` to prevent any other click listeners from being registered.
   */
  click?: Handler<ClickHandler>;

  /**
   * This is similar to the `click` handler, but with better performance when
   * only capturing clicks for marks.
   */
  clickMark?: Handler<ClickMarkHandler>;

  /**
   * Listen for contextmenu events and pass through props which detail the
   * direct node and parent nodes which were activated.
   */
  contextmenu?: Handler<(props: MouseEventHandlerProps) => boolean | undefined | void>;

  /**
   * Listen for hover events and pass through details of every node and mark
   * which was hovered at the current position.
   */
  hover?: Handler<(props: HoverEventHandlerProps) => boolean | undefined | void>;
}

/**
 * The events extension which listens to events which occur within the
 * remirror editor.
 */
@extension<EventsOptions>({
  handlerKeys: [
    'blur',
    'focus',
    'mousedown',
    'mouseup',
    'mouseenter',
    'mouseleave',
    'click',
    'clickMark',
    'contextmenu',
  ],
  handlerKeyOptions: {
    blur: { earlyReturnValue: true },
    focus: { earlyReturnValue: true },
    mousedown: { earlyReturnValue: true },
    mouseleave: { earlyReturnValue: true },
    mouseup: { earlyReturnValue: true },
    click: { earlyReturnValue: true },
  },
  defaultPriority: ExtensionPriority.Low,
})
export class EventsExtension extends PlainExtension<EventsOptions> {
  get name() {
    return 'events' as const;
  }

  /**
   * Indicates whether the user is currently interacting with the editor.
   */
  private mousedown = false;

  /**
   * True when the mouse is within the bounds of the editor.
   */
  private mouseover = false;

  /**
   * Add a new lifecycle method which is available to all extensions for adding
   * a click handler to the node or mark.
   */
  onView(): void {
    if (
      // managerSettings excluded this from running
      this.store.managerSettings.exclude?.clickHandler
    ) {
      return;
    }

    for (const extension of this.store.extensions) {
      if (
        // Method doesn't exist
        !extension.createEventHandlers ||
        // Extension settings exclude it
        extension.options.exclude?.clickHandler
      ) {
        continue;
      }

      const eventHandlers = extension.createEventHandlers();

      for (const [key, handler] of entries(eventHandlers)) {
        // Casting to `any` needed here since I don't know how to teach
        // `TypeScript` that the object key and the handler are a valid pair.
        this.addHandler(key as any, handler);
      }
    }
  }

  /**
   * Create the plugin which manages all of the events being listened to within
   * the editor.
   */
  createPlugin(): CreateExtensionPlugin {
    // Since event methods can possible be run multiple times for the same event
    // outer node, it is possible that one event can be run multiple times. To
    // prevent needless potentially expensive recalculations, this weak map
    // tracks the references to an event for automatic garbage collection when
    // the reference to the event is lost.
    const eventMap: WeakMap<Event, boolean> = new WeakMap();

    return {
      props: {
        handleClickOn: (view, pos, node, nodePos, event, direct) => {
          const state = this.store.currentState;
          const { schema, doc } = state;
          const $pos = doc.resolve(pos);

          // True when the event has already been handled. In these cases we
          // should **not** run the `clickMark` handler since all that is needed
          // is the `$pos` property to check if a mark is active.
          const handled = eventMap.has(event);

          // Generate the base state which is passed to the `clickMark` handler
          // and used to create the `click` handler state.
          const baseState = createClickMarkState({ $pos, handled, view, state });
          let returnValue = false;

          if (!handled) {
            // The boolean return value for the mark click handler. This is
            // intentionally separate so that both the `clickMark` handlers and
            // the `click` handlers are run for each click. It uses the eventMap
            // to limit the ensure that it is only run once per click since this
            // method is run with the same event for every single node in the
            // `doc` tree.
            returnValue = this.options.clickMark(event, baseState) || returnValue;
          }

          // Create click state to help API consumers inspect whether the event
          // is a relevant click type.
          const clickState: ClickHandlerState = {
            ...baseState,
            pos,
            direct,
            nodeWithPosition: { node, pos: nodePos },

            getNode: (nodeType) => {
              const type = isString(nodeType) ? schema.nodes[nodeType] : nodeType;

              invariant(type, {
                code: ErrorConstant.EXTENSION,
                message: 'The node being checked does not exist',
              });

              return type === node.type ? { node, pos: nodePos } : undefined;
            },
          };

          // Store this event so that marks aren't re-run for identical events.
          eventMap.set(event, true);

          return this.options.click(event, clickState) || returnValue;
        },

        handleDOMEvents: {
          focus: (_, event) => {
            return this.options.focus(event) || false;
          },

          blur: (_, event) => {
            return this.options.blur(event) || false;
          },

          mousedown: (_, event) => {
            this.startMouseover();
            return this.options.mousedown(event) || false;
          },

          mouseup: (_, event) => {
            this.endMouseover();
            return this.options.mouseup(event) || false;
          },

          mouseleave: (_, event) => {
            this.mouseover = false;
            return this.options.mouseleave(event) || false;
          },

          mouseenter: (_, event) => {
            this.mouseover = true;
            return this.options.mouseenter(event) || false;
          },

          mouseout: this.createMouseEventHandler(
            (props) => this.options.hover({ ...props, hovering: false }) || false,
          ),

          mouseover: this.createMouseEventHandler(
            (props) => this.options.hover({ ...props, hovering: true }) || false,
          ),

          contextmenu: this.createMouseEventHandler(
            (props) => this.options.contextmenu(props) || false,
          ),
        },
      },
    };
  }

  /**
   * Check if the user is currently interacting with the editor.
   */
  @helper()
  isInteracting(): Helper<boolean> {
    return this.mousedown && this.mouseover;
  }

  private startMouseover() {
    this.mouseover = true;

    if (this.mousedown) {
      return;
    }

    this.mousedown = true;

    this.store.document.documentElement.addEventListener(
      'mouseup',
      () => {
        this.endMouseover();
      },
      { once: true },
    );
  }

  private endMouseover() {
    if (!this.mousedown) {
      return;
    }

    this.mousedown = false;
    this.store.commands.emptyUpdate();
  }

  private readonly createMouseEventHandler = (fn: (props: MouseEventHandlerProps) => boolean) => {
    return (view: EditorView, event: MouseEvent) => {
      const eventPosition = getPositionFromEvent(view, event);

      if (!eventPosition) {
        return false;
      }

      // The nodes that are captured by the context menu. An empty array
      // means the contextmenu was trigger outside the content. The first
      // node is always the direct match.
      const nodes: NodeWithPosition[] = [];

      // The marks wrapping the captured position.
      const marks: GetMarkRange[] = [];

      const { pos, inside } = eventPosition;

      // Retrieve the resolved position from the current state.
      const $pos = view.state.doc.resolve(pos);

      // The depth of the current node (which is a direct match)
      const currentNodeDepth = $pos.depth + 1;

      // This handle the case when the context menu click has no corresponding
      // nodes or marks because it's outside of any editor content.
      if (inside > -1) {
        // Populate the nodes.
        for (const index of range(currentNodeDepth, 1)) {
          nodes.push({
            node: index > $pos.depth && $pos.nodeAfter ? $pos.nodeAfter : $pos.node(index),
            pos: $pos.before(index),
          });
        }

        // Populate the marks.
        for (const { type } of $pos.marks()) {
          const range = getMarkRange($pos, type);

          if (range) {
            marks.push(range);
          }
        }
      }

      const isCaptured = fn({
        event,
        view,
        nodes,
        marks,
        getMark: (markType) => {
          const type = isString(markType) ? view.state.schema.marks[markType] : markType;

          invariant(type, {
            code: ErrorConstant.EXTENSION,
            message: `The mark ${markType} being checked does not exist within the editor schema.`,
          });

          return marks.find((range) => range.mark.type === type);
        },
        getNode: (nodeType) => {
          const type = isString(nodeType) ? view.state.schema.nodes[nodeType] : nodeType;

          invariant(type, {
            code: ErrorConstant.EXTENSION,
            message: 'The node being checked does not exist',
          });

          const nodeWithPos = nodes.find(({ node }) => node.type === type);

          if (!nodeWithPos) {
            return;
          }

          return { ...nodeWithPos, isRoot: !!nodes[0]?.node.eq(nodeWithPos.node) };
        },
      });

      if (isCaptured) {
        event.preventDefault();
      }

      return isCaptured;
    };
  };
}

interface CreateClickMarkStateProps extends BaseEventState {
  /**
   * True when the event has previously been handled. In this situation we can
   * return early, since the mark can be checked directly from the current
   * position.
   */
  handled: boolean;

  /**
   * The resolved position to check for marks.
   */
  $pos: ResolvedPos;
}

/**
 * Create the click handler state for the mark.
 */
function createClickMarkState(props: CreateClickMarkStateProps): ClickMarkHandlerState {
  const { handled, view, $pos, state } = props;
  const clickState: ClickMarkHandlerState = { getMark: noop, markRanges: [], view, state };

  if (handled) {
    return clickState;
  }

  for (const { type } of $pos.marks()) {
    const range = getMarkRange($pos, type);

    if (range) {
      clickState.markRanges.push(range);
    }
  }

  clickState.getMark = (markType) => {
    const type = isString(markType) ? state.schema.marks[markType] : markType;

    invariant(type, {
      code: ErrorConstant.EXTENSION,
      message: `The mark ${markType} being checked does not exist within the editor schema.`,
    });

    return clickState.markRanges.find((range) => range.mark.type === type);
  };

  return clickState;
}

/**
 * The click handler for events.
 */
export type ClickHandler = (
  event: MouseEvent,
  clickState: ClickHandlerState,
) => boolean | undefined | void;

export interface ClickMarkHandlerState extends BaseEventState {
  /**
   * Return the mark range if it exists for the clicked position.
   */
  getMark: (markType: string | MarkType) => GetMarkRange | undefined | void;

  /**
   * The list of mark ranges included. This is only populated when `direct` is
   * true.
   */
  markRanges: GetMarkRange[];
}

/**
 * An event solely focused on clicks on marks.
 */
export type ClickMarkHandler = (
  event: MouseEvent,
  clickState: ClickMarkHandlerState,
) => boolean | undefined | void;

/**
 * The helpers passed into the `ClickHandler`.
 */
export interface ClickHandlerState extends ClickMarkHandlerState {
  /**
   * The position that was clicked.
   */
  pos: number;

  /**
   * Returns undefined when the nodeType doesn't match. Otherwise returns the
   * node with a position property.
   */
  getNode: (nodeType: string | NodeType) => NodeWithPosition | undefined;

  /**
   * The node that was clicked with the desired position.
   */
  nodeWithPosition: NodeWithPosition;

  /**
   * When this is true it means that the current clicked node is the node that
   * was directly clicked.
   */
  direct: boolean;
}

/**
 * The return type for the `createEventHandlers` extension creator method.
 */
export type CreateEventHandlers = GetHandler<EventsOptions>;

interface BaseEventState extends EditorViewProps, EditorStateProps {
  /**
   * The editor state before updates from the event.
   */
  state: EditorState;
}

export interface HoverEventHandlerProps extends MouseEventHandlerProps {
  /**
   * This is true when hovering has started and false when hovering has ended.
   */
  hovering: boolean;
}

export interface MouseEventHandlerProps {
  /**
   * The editor view.
   */
  view: EditorView;

  /**
   * The marks that currently wrap the context menu.
   */
  marks: GetMarkRange[];

  /**
   * An array of nodes with their positions. The first node is the node that was
   * acted on directly, and each node after is the parent of the one proceeding.
   * Consumers of this API can check if a node of a specific type was triggered
   * to determine how to render their context menu.
   */
  nodes: NodeWithPosition[];

  /**
   * The event that triggered this.
   */
  event: MouseEvent;

  /**
   * Return the mark range if it exists for the clicked position.
   *
   *
   */
  getMark: (markType: string | MarkType) => GetMarkRange | undefined | void;

  /**
   * Returns undefined when the nodeType doesn't match. Otherwise returns the
   * node with a position property and `isRoot` which is true when the node was
   * clicked on directly.
   */
  getNode: (
    nodeType: string | NodeType,
  ) => (NodeWithPosition & { isRoot: boolean }) | undefined | void;
}

declare global {
  namespace Remirror {
    interface ExcludeOptions {
      /**
       * Whether to exclude the extension's `clickHandler`.
       *
       * @default undefined
       */
      clickHandler?: boolean;
    }

    interface BaseExtension {
      /**
       * Create a click handler for this extension. Returns a function which is
       * used as the click handler. The callback provided is handled via the
       * `Events` extension and comes with a helpers object
       * `ClickHandlerHelper`.
       *
       * The returned function should return `true` if you want to prevent any
       * further click handlers from being handled.
       */
      createEventHandlers?(): CreateEventHandlers;
    }
    interface AllExtensions {
      events: EventsExtension;
    }
  }
}