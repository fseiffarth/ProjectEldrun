import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useViewerState } from "./FileViewerPane";
import {
  parseYaml,
  setValue,
  renameKey,
  deleteNode,
  addChild,
  addRootEntry,
  moveNode,
  moveNodeTo,
  canAddChild,
  canComment,
  commentOf,
  setComment,
  isFlow,
  literalFor,
  scalarType,
  type YamlDoc,
  type YamlNode,
  type YamlValueType,
} from "../../lib/viewers/yaml";

/**
 * The YAML/JSON tree editor (#yaml) — the structured half of the viewer, the way
 * the rendered preview is the structured half of the markdown viewer.
 *
 * It edits the FILE TEXT, not a model of it: every action here is a splice back
 * into `text` (see `lib/viewers/yaml`), and the result goes straight to the same
 * draft the Source tab shows. That is the whole design — the two modes never
 * convert between representations, so comments and formatting survive an edit,
 * and Ctrl+S / undo / redo / format / validation all keep working on the text
 * underneath without knowing the tree exists.
 *
 * Both syntaxes render as one tree, and each keeps its own: a block collection
 * grows by lines, a flow one (`{a: 1}` — i.e. JSON) grows inside its brackets.
 * `strict` is set for a `.json` file, where every key and string is quoted.
 *
 * What the tree offers, it can do: a node the parser cannot rewrite safely (an
 * anchor, an alias, a merge key, a plain scalar continued across lines) renders
 * with its edit affordances withheld rather than a control that would corrupt the
 * file.
 */
export function YamlTree({
  text,
  onChange,
  tabKey,
  fontSize,
  strict,
}: {
  text: string;
  onChange: (next: string) => void;
  tabKey?: string;
  fontSize?: number;
  /** JSON dialect (a `.json` file): keys and strings are always quoted. */
  strict?: boolean;
}) {
  const doc = useMemo(() => parseYaml(text, { strict }), [text, strict]);

  // Collapse state rides with the tab (like the reader's scroll position), so
  // folding a big config stays folded across a reopen and a restart.
  const viewPos = useViewerState(tabKey);
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () => new Set(viewPos.initial?.yamlCollapsed ?? []),
  );
  const toggle = useCallback(
    (id: string) => {
      setCollapsed((cur) => {
        const next = new Set(cur);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        viewPos.persist({ yamlCollapsed: [...next] });
        return next;
      });
    },
    [viewPos],
  );

  // The row currently showing its "add entry" form, as `${parentId}:${kind}`.
  const [adding, setAdding] = useState<string | null>(null);

  if (doc.error) {
    return (
      <div className="yaml-tree-notice">
        <p>
          The tree can't read this file: {doc.error.message} (line {doc.error.line})
        </p>
        <p className="yaml-tree-notice-hint">
          Switch to <strong>Source</strong> to edit it as text — nothing here has been changed.
        </p>
      </div>
    );
  }

  if (!doc.docs.length) {
    return (
      <div className="yaml-tree" style={fontSize ? { fontSize: `${fontSize}px` } : undefined}>
        <div className="yaml-tree-notice">
          <p>This file has no entries yet.</p>
        </div>
        {adding ? (
          <AddRow
            depth={0}
            kind={adding === "root:item" ? "item" : "key"}
            onCancel={() => setAdding(null)}
            onAdd={(kind, key, type, value) => {
              onChange(
                addRootEntry(text, kind, key, literalFor(type, value, doc.strict), doc.strict),
              );
              setAdding(null);
            }}
          />
        ) : (
          <div className="yaml-row yaml-row-add">
            <button className="yaml-add" onClick={() => setAdding("root:key")}>
              + key
            </button>
            <button className="yaml-add" onClick={() => setAdding("root:item")}>
              + item
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="yaml-tree" style={fontSize ? { fontSize: `${fontSize}px` } : undefined}>
      {doc.docs.map((root, i) => (
        <div className="yaml-doc" key={root.id}>
          {doc.docs.length > 1 && <div className="yaml-doc-sep">document {i + 1}</div>}
          <YamlRows
            nodes={root.children}
            parent={root}
            depth={0}
            text={text}
            doc={doc}
            onChange={onChange}
            collapsed={collapsed}
            toggle={toggle}
            adding={adding}
            setAdding={setAdding}
          />
          {adding?.startsWith(`${root.id}:`) ? (
            <AddRow
              depth={0}
              kind={adding.endsWith(":item") ? "item" : "key"}
              onCancel={() => setAdding(null)}
              onAdd={(kind, key, type, value) => {
                onChange(
                  addChild(text, doc, root, kind, key, literalFor(type, value, doc.strict)),
                );
                setAdding(null);
              }}
            />
          ) : (
            <AddControls node={root} adding={adding} setAdding={setAdding} />
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * One level of siblings. Split out so a row's children re-render on their own — and
 * because it is the natural home for the drag: a node can only be reordered AMONG
 * ITS SIBLINGS (there is no such thing as dragging a key into a different mapping —
 * that is a re-parent, not a reorder), so the list that owns them owns the gesture.
 *
 * The drag is pointer-based, not HTML5 drag-and-drop, which does not work under
 * WebKitGTK; and every pointer handler is bound to the grip up front rather than
 * added to the window mid-gesture, because listeners registered once a gesture is
 * already under way are the ones WebKitGTK drops.
 */
function YamlRows({
  nodes,
  parent,
  depth,
  text,
  doc,
  onChange,
  collapsed,
  toggle,
  adding,
  setAdding,
}: {
  nodes: YamlNode[];
  parent: YamlNode;
  depth: number;
  text: string;
  doc: YamlDoc;
  onChange: (next: string) => void;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  adding: string | null;
  setAdding: (v: string | null) => void;
}) {
  const rows = useRef<(HTMLDivElement | null)[]>([]);
  // The live gesture is a ref (the pointer handlers read it without re-binding) and
  // state (the drop line has to render).
  const live = useRef<{ from: number; to: number } | null>(null);
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null);

  // Which sibling the pointer is over. A sibling's band runs from its own row down
  // to the next sibling's — so pointing anywhere inside a container's subtree lands
  // on the container, which is the only thing at this depth that the pointer could
  // mean.
  const indexAt = (y: number) => {
    let k = 0;
    for (let i = 0; i < nodes.length; i++) {
      const el = rows.current[i];
      if (el && y >= el.getBoundingClientRect().top) k = i;
    }
    return k;
  };

  const start = (i: number) => {
    live.current = { from: i, to: i };
    setDrag(live.current);
  };
  const over = (y: number) => {
    const d = live.current;
    if (!d) return;
    const to = indexAt(y);
    if (to !== d.to) {
      live.current = { from: d.from, to };
      setDrag(live.current);
    }
  };
  const drop = () => {
    const d = live.current;
    live.current = null;
    setDrag(null);
    if (d && d.to !== d.from) onChange(moveNodeTo(text, nodes, nodes[d.from], d.to));
  };

  return (
    <>
      {nodes.map((node, i) => (
        <YamlRow
          key={node.id}
          node={node}
          index={i}
          siblings={nodes}
          parentKind={parent.kind}
          depth={depth}
          text={text}
          doc={doc}
          onChange={onChange}
          collapsed={collapsed}
          toggle={toggle}
          adding={adding}
          setAdding={setAdding}
          rowRef={(el) => {
            rows.current[i] = el;
          }}
          dragging={drag?.from === i}
          // The drop line goes on the row the node would land at, on the side it
          // would come to rest — so the gesture shows where the text will end up.
          dropSide={
            drag && drag.to === i && drag.to !== drag.from
              ? drag.to < drag.from
                ? "before"
                : "after"
              : null
          }
          onDragStart={start}
          onDragOver={over}
          onDragEnd={drop}
        />
      ))}
    </>
  );
}

function YamlRow({
  node,
  index,
  siblings,
  parentKind,
  depth,
  text,
  doc,
  onChange,
  collapsed,
  toggle,
  adding,
  setAdding,
  rowRef,
  dragging,
  dropSide,
  onDragStart,
  onDragOver,
  onDragEnd,
}: {
  node: YamlNode;
  index: number;
  siblings: YamlNode[];
  parentKind: string;
  depth: number;
  text: string;
  doc: YamlDoc;
  onChange: (next: string) => void;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  adding: string | null;
  setAdding: (v: string | null) => void;
  rowRef: (el: HTMLDivElement | null) => void;
  dragging: boolean;
  dropSide: "before" | "after" | null;
  onDragStart: (index: number) => void;
  onDragOver: (clientY: number) => void;
  onDragEnd: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [noting, setNoting] = useState(false);
  const isContainer = node.kind !== "scalar";
  const isOpen = !collapsed.has(node.id);
  const inSeq = parentKind === "seq";

  // What this row is called in an action's label. A list item has no key, and
  // "Delete item" would name every sibling equally — to a screen reader and to a
  // test alike — so it is named by its index.
  const label = inSeq ? `item ${index}` : (node.key ?? "");
  const count = isContainer
    ? node.kind === "seq"
      ? `${node.children.length} item${node.children.length === 1 ? "" : "s"}`
      : `${node.children.length} key${node.children.length === 1 ? "" : "s"}`
    : null;

  // The same rule as the ↑/↓ buttons: an entry that does not own its line (the key
  // written on its item's dash) cannot be moved off it.
  const movable = node.deletable && siblings.length > 1;
  const note = commentOf(node);
  // What the key says about itself on hover: its comment if it has one, since that
  // is the only place a YAML file documents a key.
  const keyTitle = note ? `# ${note}` : "Click to rename this key";

  return (
    <>
      <div
        ref={rowRef}
        className={[
          "yaml-row",
          dragging ? "yaml-row-dragging" : "",
          dropSide ? `yaml-row-drop-${dropSide}` : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {movable ? (
          <button
            className="yaml-grip"
            title="Drag to reorder"
            aria-label={`Reorder ${label}`}
            onPointerDown={(e) => {
              // Pointer capture keeps every later event on the grip, so the gesture
              // survives the pointer leaving the row (which is the whole point of it).
              // Optional because it is the one part of this not every environment
              // implements — jsdom has no pointer capture, and the drag is still the
              // drag without it.
              e.preventDefault();
              e.currentTarget.setPointerCapture?.(e.pointerId);
              onDragStart(index);
            }}
            onPointerMove={(e) => onDragOver(e.clientY)}
            onPointerUp={(e) => {
              e.currentTarget.releasePointerCapture?.(e.pointerId);
              onDragEnd();
            }}
            onPointerCancel={onDragEnd}
          >
            ⠿
          </button>
        ) : (
          <span className="yaml-grip yaml-grip-empty" aria-hidden="true" />
        )}

        {isContainer && node.children.length > 0 ? (
          <button
            className="yaml-caret"
            onClick={() => toggle(node.id)}
            aria-expanded={isOpen}
            aria-label={isOpen ? `Collapse ${label}` : `Expand ${label}`}
          >
            {isOpen ? "▾" : "▸"}
          </button>
        ) : (
          <span className="yaml-caret yaml-caret-empty" aria-hidden="true" />
        )}

        {inSeq ? (
          <span className="yaml-index" title={note ? `# ${note}` : undefined}>
            {index}
          </span>
        ) : renaming ? (
          <TextCommit
            initial={node.key ?? ""}
            className="yaml-key-input"
            ariaLabel={`Rename key ${node.key ?? ""}`}
            onCommit={(next) => {
              setRenaming(false);
              if (next && next !== node.key) onChange(renameKey(text, doc, node, next));
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <button className="yaml-key" onClick={() => setRenaming(true)} title={keyTitle}>
            {node.key}
            <span className="yaml-colon">:</span>
          </button>
        )}

        {node.kind === "scalar" ? (
          <ValueCell
            node={node}
            label={label}
            onCommit={(next) => onChange(setValue(text, doc, node, next))}
          />
        ) : (
          <span className="yaml-count">
            {/* Flow (JSON) style is visible, because it is what the row's edits
                will keep: adding here splices into the brackets, not new lines. */}
            {isFlow(node) && (
              <span className="yaml-flow-tag" title="Written in flow (JSON) style">
                {node.kind === "seq" ? "[ ]" : "{ }"}
              </span>
            )}
            {count}
          </span>
        )}

        {/* The comment editor takes the row while it is open, since it is prose about
            the whole entry rather than one more field on it. */}
        {noting && (
          <TextCommit
            initial={note}
            className="yaml-comment-input"
            ariaLabel={`Comment on ${label}`}
            placeholder="comment"
            onCommit={(next) => {
              setNoting(false);
              if (next !== note) onChange(setComment(text, doc, node, next));
            }}
            onCancel={() => setNoting(false)}
          />
        )}

        {/* A row that HAS a comment says so without being hovered — a config file's
            comments are the half of it worth reading, and hiding them behind a hover
            would be hiding the documentation. The text itself stays on the hover. */}
        {note && !noting && canComment(doc, node) && (
          <button
            className="yaml-note"
            title={`# ${note}`}
            aria-label={`Comment on ${label}`}
            onClick={() => setNoting(true)}
          >
            #
          </button>
        )}

        <span className="yaml-actions">
          {/* An empty key (`key:`, `key: null`, `key: []`) offers both — its first
              child is what decides whether it becomes a mapping or a list. A LIST
              offers both too: "+ key" on it adds an item that IS a mapping. */}
          {(canAddChild(node, "key") || canAddChild(node, "item")) && (
            <AddControls node={node} adding={adding} setAdding={setAdding} inline />
          )}
          {!note && !noting && canComment(doc, node) && (
            <button
              className="yaml-act"
              onClick={() => setNoting(true)}
              title="Add a comment"
              aria-label={`Comment on ${label}`}
            >
              #
            </button>
          )}
          {movable && (
            <>
              <button
                className="yaml-act"
                disabled={index === 0}
                onClick={() => onChange(moveNode(text, siblings, node, -1))}
                title="Move up"
                aria-label={`Move ${label} up`}
              >
                ↑
              </button>
              <button
                className="yaml-act"
                disabled={index === siblings.length - 1}
                onClick={() => onChange(moveNode(text, siblings, node, 1))}
                title="Move down"
                aria-label={`Move ${label} down`}
              >
                ↓
              </button>
            </>
          )}
          {node.deletable && (
            <button
              className="yaml-act yaml-act-del"
              onClick={() => onChange(deleteNode(text, node))}
              title={isContainer ? "Delete this entry and everything under it" : "Delete this entry"}
              aria-label={`Delete ${label}`}
            >
              ×
            </button>
          )}
          {!node.editable && (
            <span
              className="yaml-locked"
              title="The tree can't rewrite this safely (an anchor, a merge key, or a multi-line value) — edit it in Source."
            >
              source only
            </span>
          )}
        </span>
      </div>

      {isContainer && isOpen && (
        <YamlRows
          nodes={node.children}
          parent={node}
          depth={depth + 1}
          text={text}
          doc={doc}
          onChange={onChange}
          collapsed={collapsed}
          toggle={toggle}
          adding={adding}
          setAdding={setAdding}
        />
      )}

      {/* The add form opens as the last child of the row it belongs to. */}
      {adding?.startsWith(`${node.id}:`) && (
        <AddRow
          depth={depth + 1}
          kind={adding.endsWith(":item") ? "item" : "key"}
          onCancel={() => setAdding(null)}
          onAdd={(kind, key, type, value) => {
            onChange(addChild(text, doc, node, kind, key, literalFor(type, value, doc.strict)));
            setAdding(null);
          }}
        />
      )}
    </>
  );
}

/** The `+ key` / `+ item` buttons a node offers, given what it can actually take. */
function AddControls({
  node,
  adding,
  setAdding,
  inline,
}: {
  node: YamlNode;
  adding: string | null;
  setAdding: (v: string | null) => void;
  inline?: boolean;
}) {
  const open = adding?.startsWith(`${node.id}:`);
  return (
    <span className={inline ? "yaml-add-inline" : "yaml-row yaml-row-add"}>
      {canAddChild(node, "key") && (
        <button
          className="yaml-add"
          onClick={() => setAdding(open ? null : `${node.id}:key`)}
          // On a list a key is not a key but an item that is a mapping — the shape a
          // list of mappings is actually grown by (`- name: api`).
          title={
            node.kind === "seq"
              ? "Add an item that is a mapping (- key: value)"
              : "Add a key under this entry"
          }
        >
          + key
        </button>
      )}
      {canAddChild(node, "item") && (
        <button
          className="yaml-add"
          onClick={() => setAdding(open ? null : `${node.id}:item`)}
          title="Add an item to this list"
        >
          + item
        </button>
      )}
    </span>
  );
}

/** The inline form a new entry is composed in: key (mappings only), type, value. */
function AddRow({
  depth,
  kind,
  onAdd,
  onCancel,
}: {
  depth: number;
  kind: "key" | "item";
  onAdd: (kind: "key" | "item", key: string, type: YamlValueType, value: string) => void;
  onCancel: () => void;
}) {
  const [key, setKey] = useState("");
  const [type, setType] = useState<YamlValueType>("text");
  const [value, setValue] = useState("");
  const first = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);

  // A container's value is its children, and null has no value to type.
  const valueless = type === "map" || type === "seq" || type === "null";
  const canAdd = kind === "item" || key.trim() !== "";
  const submit = () => {
    if (canAdd) onAdd(kind, key.trim(), type, value);
  };

  return (
    <div
      className="yaml-row yaml-row-form"
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <span className="yaml-caret yaml-caret-empty" aria-hidden="true" />
      {kind === "key" ? (
        <input
          ref={first}
          className="yaml-key-input"
          value={key}
          placeholder="key"
          aria-label="New key"
          onChange={(e) => setKey(e.target.value)}
        />
      ) : (
        <span className="yaml-index">–</span>
      )}
      <select
        className="yaml-type"
        value={type}
        aria-label="Value type"
        onChange={(e) => setType(e.target.value as YamlValueType)}
      >
        <option value="text">text</option>
        <option value="number">number</option>
        <option value="boolean">boolean</option>
        <option value="null">null</option>
        <option value="map">map</option>
        <option value="seq">list</option>
      </select>
      {type === "boolean" ? (
        <select
          className="yaml-type"
          value={value || "true"}
          aria-label="New value"
          onChange={(e) => setValue(e.target.value)}
        >
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      ) : (
        !valueless && (
          <input
            ref={kind === "item" ? first : undefined}
            className="yaml-value-input"
            value={value}
            placeholder="value"
            aria-label="New value"
            onChange={(e) => setValue(e.target.value)}
          />
        )
      )}
      <button className="yaml-add" onClick={submit} disabled={!canAdd}>
        Add
      </button>
      <button className="yaml-act" onClick={onCancel} aria-label="Cancel">
        ×
      </button>
    </div>
  );
}

/** A scalar's value: an input (a textarea for a block scalar) that commits on
 *  Enter/blur, or plain text when the node is one the tree won't rewrite. */
function ValueCell({
  node,
  label,
  onCommit,
}: {
  node: YamlNode;
  label: string;
  onCommit: (next: string) => void;
}) {
  if (!node.editable) {
    return (
      <span className="yaml-value yaml-value-locked" title={node.raw}>
        {node.raw || node.value}
      </span>
    );
  }
  if (node.style === "block") {
    return (
      <BlockCell
        key={node.id}
        initial={node.value}
        tag={node.raw}
        ariaLabel={`Value of ${label}`}
        onCommit={onCommit}
      />
    );
  }
  return (
    <TextCommit
      initial={node.value}
      className={`yaml-value-input yaml-val-${scalarType(node)}`}
      ariaLabel={`Value of ${label}`}
      placeholder={node.style === "empty" ? "null" : undefined}
      onCommit={onCommit}
    />
  );
}

/** A multi-line block scalar (`|`/`>`): committed on blur or Ctrl+Enter, since
 *  plain Enter has to keep inserting newlines. */
function BlockCell({
  initial,
  tag,
  ariaLabel,
  onCommit,
}: {
  initial: string;
  /** The block header as written (`|`, `>-`, …), shown so the style is visible. */
  tag: string;
  ariaLabel: string;
  onCommit: (next: string) => void;
}) {
  const [buf, setBuf] = useState(initial);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setBuf(initial);
  }, [initial]);

  return (
    <span className="yaml-block">
      <span className="yaml-block-tag">{tag}</span>
      <textarea
        className="yaml-block-input"
        value={buf}
        rows={Math.min(12, Math.max(2, buf.split("\n").length))}
        aria-label={ariaLabel}
        onChange={(e) => {
          dirty.current = true;
          setBuf(e.target.value);
        }}
        onBlur={() => {
          dirty.current = false;
          if (buf !== initial) onCommit(buf);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            dirty.current = false;
            setBuf(initial);
          }
        }}
      />
    </span>
  );
}

/**
 * A single-line input that commits on Enter/blur and reverts on Escape. It holds
 * its own buffer rather than driving `onChange` per keystroke: every commit
 * re-encodes the value into the file (quoting it when it must), and doing that on
 * each keypress would rewrite the text — and move the caret — under the typist.
 */
function TextCommit({
  initial,
  className,
  ariaLabel,
  placeholder,
  onCommit,
  onCancel,
}: {
  initial: string;
  className: string;
  ariaLabel: string;
  placeholder?: string;
  onCommit: (next: string) => void;
  onCancel?: () => void;
}) {
  const [buf, setBuf] = useState(initial);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) setBuf(initial);
  }, [initial]);

  return (
    <input
      className={className}
      value={buf}
      placeholder={placeholder}
      aria-label={ariaLabel}
      autoFocus={!!onCancel}
      onChange={(e) => {
        dirty.current = true;
        setBuf(e.target.value);
      }}
      onBlur={() => {
        dirty.current = false;
        if (buf !== initial) onCommit(buf);
        else onCancel?.();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          dirty.current = false;
          if (buf !== initial) onCommit(buf);
          else onCancel?.();
        } else if (e.key === "Escape") {
          e.preventDefault();
          dirty.current = false;
          setBuf(initial);
          onCancel?.();
        }
      }}
    />
  );
}
