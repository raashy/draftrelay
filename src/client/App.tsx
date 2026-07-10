import {
  AlertTriangle,
  Bell,
  BellRing,
  Check,
  CheckCircle2,
  CircleDot,
  ClipboardCopy,
  Code2,
  Copy,
  Eye,
  FileText,
  FolderClosed,
  GitBranch,
  History,
  Inbox,
  LoaderCircle,
  LockKeyhole,
  Mail,
  MessageSquare,
  PencilLine,
  RefreshCw,
  RotateCcw,
  Search,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  SquareTerminal,
  Trash2,
  Undo2,
  UserRound,
  WifiOff,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import {
  acknowledgeFinding,
  createProjectSecretPattern,
  createRevision,
  deleteItem,
  getFindings,
  getItem,
  getProjectPolicy,
  getProjectSecretPatterns,
  getProjects,
  getRecipes,
  getRepresentation,
  getRevisions,
  listItems,
  recordCopy,
  requestJson,
  transitionItem,
  deleteProjectSecretPattern,
  updateProjectPolicy
} from "./api";
import { copyRepresentation, copyText, destinationLabel, type CopyFormat } from "./clipboard";
import { diffLines } from "./diff";
import { nextRovingTabIndex } from "./roving-tabs";
import type {
  ApiFacets,
  ArtifactRevision,
  Destination,
  DumpItem,
  FacetEntry,
  FacetOption,
  LifecycleStatus,
  ProjectPolicy,
  ProjectSecretPattern,
  ProjectSummary,
  RecipeSummary,
  Representation,
  SecretFinding
} from "./types";

type LifecycleView = LifecycleStatus | "all";
type DetailTab = "preview" | "revisions" | "provenance" | "safety";
type HealthState = "checking" | "online" | "offline";

interface Filters {
  project: string;
  recipe: string;
  tag: string;
}

interface ToastState {
  id: number;
  message: string;
  actionLabel?: string;
  action?: () => void | Promise<void>;
}

const EMPTY_FILTERS: Filters = { project: "", recipe: "", tag: "" };
const POLL_INTERVAL_MS = 2_500;
const STATUS_META: Record<LifecycleStatus, { label: string; description: string }> = {
  new: { label: "Needs review", description: "Fresh agent deliverables" },
  reviewed: { label: "Reviewed", description: "Approved by a human" },
  copied: { label: "Copied", description: "Used in a destination" },
  done: { label: "Done", description: "Cleared from the outbox" }
};
const DESTINATION_ICONS: Record<Destination, typeof Copy> = {
  slack: MessageSquare,
  email: Mail,
  github: GitBranch,
  plain: FileText,
  markdown: Code2
};

function statusOf(item: DumpItem): LifecycleStatus {
  return item.status ?? (item.archivedAt ? "done" : "new");
}

function destinationsOf(item: DumpItem): Destination[] {
  const values = item.availableDestinations?.length
    ? item.availableDestinations
    : (["markdown", "plain"] as Destination[]);
  return [...new Set(values)];
}

function defaultDestinationOf(item: DumpItem): Destination {
  return item.defaultDestination ?? destinationsOf(item)[0] ?? "markdown";
}

function updateItemQuery(itemId: string | null): void {
  const url = new URL(window.location.href);
  if (itemId) url.searchParams.set("item", itemId);
  else url.searchParams.delete("item");
  window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something unexpected happened.";
}

function normalizeFacet(source: FacetEntry[] | Record<string, number> | undefined): FacetOption[] {
  if (!source) return [];
  const entries: FacetOption[] = Array.isArray(source)
    ? source.flatMap((entry) => {
        if (typeof entry === "string") return [{ value: entry }];
        const value = entry.value ?? entry.name ?? entry.label;
        return value ? [{ value, count: entry.count }] : [];
      })
    : Object.entries(source).map(([value, count]) => ({ value, count }));
  return entries.filter((entry) => entry.value.trim().length > 0);
}

function mergeOptions(fromApi: FacetOption[], fromItems: string[], selected: string): FacetOption[] {
  const values = new Map<string, FacetOption>();
  fromApi.forEach((entry) => values.set(entry.value, entry));
  fromItems.forEach((value) => {
    if (value) values.set(value, values.get(value) ?? { value });
  });
  if (selected) values.set(selected, values.get(selected) ?? { value: selected });
  return [...values.values()].sort((left, right) =>
    left.value.localeCompare(right.value, undefined, { sensitivity: "base" })
  );
}

function formatRelativeDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown time";
  const seconds = Math.round((date.getTime() - Date.now()) / 1_000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const ranges: Array<[number, Intl.RelativeTimeFormatUnit]> = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.345, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"]
  ];
  let duration = seconds;
  for (const [amount, unit] of ranges) {
    if (Math.abs(duration) < amount) return formatter.format(duration, unit);
    duration = Math.round(duration / amount);
  }
  return formatter.format(duration, "year");
}

function formatExactDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function keepFocusInside(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key !== "Tab") return;
  const focusable = Array.from(
    event.currentTarget.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
  if (!focusable.length) {
    event.preventDefault();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (!event.currentTarget.contains(active)) {
    event.preventDefault();
    first.focus();
  } else if (event.shiftKey && active === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

interface MarkdownBodyProps {
  content: string;
  className?: string;
  focusScrollableRegions?: boolean;
}

function MarkdownBody({ content, className = "", focusScrollableRegions = false }: MarkdownBodyProps) {
  return (
    <div className={`markdown-body ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ node: _node, ...props }) => (
            <a {...props} target="_blank" rel="noreferrer noopener" referrerPolicy="no-referrer" />
          ),
          img: ({ node: _node, alt }) => (
            <span className="markdown-image-placeholder" role="note">
              Image omitted{alt ? `: ${alt}` : ""}
            </span>
          ),
          pre: ({ node: _node, ...props }) => (
            <pre {...props} tabIndex={focusScrollableRegions ? 0 : undefined} />
          ),
          table: ({ node: _node, ...props }) => (
            <table {...props} tabIndex={focusScrollableRegions ? 0 : undefined} />
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

interface FilterSelectProps {
  id: string;
  label: string;
  value: string;
  options: FacetOption[];
  onChange: (value: string) => void;
}

function FilterSelect({ id, label, value, options, onChange }: FilterSelectProps) {
  return (
    <label className="filter-field" htmlFor={id}>
      <span>{label}</span>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">All {label.toLowerCase()}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.value}{option.count === undefined ? "" : ` · ${option.count}`}
          </option>
        ))}
      </select>
    </label>
  );
}

interface ArtifactCardProps {
  item: DumpItem;
  recipeName: string;
  busy: boolean;
  onOpen: (item: DumpItem) => void;
  onCopy: (item: DumpItem, destination?: Destination) => void;
  onTransition: (item: DumpItem, status: LifecycleStatus) => void;
  onDelete: (item: DumpItem) => void;
}

function ArtifactCard({
  item,
  recipeName,
  busy,
  onOpen,
  onCopy,
  onTransition,
  onDelete
}: ArtifactCardProps) {
  const status = statusOf(item);
  const destination = defaultDestinationOf(item);
  const DestinationIcon = DESTINATION_ICONS[destination];
  const openFindings = item.secretFindings?.filter((finding) => finding.status === "open") ?? [];
  const provenance = item.provenance;

  return (
    <article className={`clip-card artifact-card artifact-card--${status}`}>
      <div className="clip-card__rule" aria-hidden="true" />
      <div className="clip-card__meta">
        <span className={`status-pill status-pill--${status}`}>
          <CircleDot size={11} aria-hidden="true" />{STATUS_META[status].label}
        </span>
        <time dateTime={item.createdAt} title={formatExactDate(item.createdAt)}>
          {formatRelativeDate(item.createdAt)}
        </time>
      </div>

      <div className="artifact-card__recipe-row">
        <span className="recipe-badge">{recipeName}</span>
        {(item.revisionCount ?? 1) > 1 && (
          <span className="revision-badge"><History size={12} />v{item.currentRevision ?? 1}</span>
        )}
        {item.humanEdited && <span className="human-edited">human edited</span>}
      </div>

      <button className="clip-card__title" type="button" onClick={() => onOpen(item)}>
        {item.title || "Untitled deliverable"}
      </button>

      <div className="clip-card__context">
        <span><FolderClosed size={13} />{item.project || "General"}</span>
        {(provenance?.branch || provenance?.sourceClient || item.sourceClient) && (
          <span className="source-pill">
            {provenance?.branch ? <GitBranch size={12} /> : null}
            {provenance?.branch ?? provenance?.sourceClient ?? item.sourceClient}
          </span>
        )}
      </div>

      <button className="clip-card__preview artifact-preview" type="button" onClick={() => onOpen(item)}>
        <MarkdownBody content={item.contentMarkdown} />
        <span className="preview-fade"><span>Review deliverable</span></span>
      </button>

      <div className="artifact-signals">
        {openFindings.length > 0 && (
          <span className="signal-chip signal-chip--warning">
            <ShieldAlert size={13} />{openFindings.length} safety {openFindings.length === 1 ? "warning" : "warnings"}
          </span>
        )}
        {item.tags.slice(0, 3).map((tag) => <span className="signal-chip" key={tag}>#{tag}</span>)}
      </div>

      <div className="clip-card__actions">
        <button
          className="action action--primary"
          type="button"
          disabled={busy}
          onClick={() => onCopy(item, destination)}
        >
          {busy ? <LoaderCircle className="spin" size={15} /> : <DestinationIcon size={15} />}
          Copy for {destinationLabel(destination)}
        </button>
        {status === "new" && (
          <button className="icon-action" type="button" onClick={() => onTransition(item, "reviewed")} title="Mark reviewed" aria-label={`Mark ${item.title} reviewed`}>
            <Eye size={16} />
          </button>
        )}
        {status !== "done" ? (
          <button className="icon-action" type="button" onClick={() => onTransition(item, "done")} title="Complete" aria-label={`Complete ${item.title}`}>
            <CheckCircle2 size={16} />
          </button>
        ) : (
          <button className="icon-action" type="button" onClick={() => onTransition(item, "new")} title="Reopen" aria-label={`Reopen ${item.title}`}>
            <RotateCcw size={16} />
          </button>
        )}
        <span className="action-spacer" />
        <button className="icon-action icon-action--danger" type="button" onClick={() => onDelete(item)} title="Delete permanently" aria-label={`Delete ${item.title}`}>
          <Trash2 size={16} />
        </button>
      </div>
    </article>
  );
}

interface RevisionPanelProps {
  item: DumpItem;
  revisions: ArtifactRevision[];
  loading: boolean;
  onRevised: (item: DumpItem) => void;
  showToast: (message: string) => void;
}

function RevisionPanel({ item, revisions, loading, onRevised, showToast }: RevisionPanelProps) {
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);
  const [content, setContent] = useState(item.contentMarkdown);
  const [changeNote, setChangeNote] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTitle(item.title);
    setContent(item.contentMarkdown);
    setChangeNote("");
  }, [item.id, item.title, item.contentMarkdown]);

  const ordered = useMemo(
    () => [...revisions].sort((left, right) => left.revision - right.revision),
    [revisions]
  );
  const selected = ordered.find((revision) => revision.revision === selectedVersion) ?? ordered.at(-1);
  const selectedIndex = selected ? ordered.findIndex((revision) => revision.id === selected.id) : -1;
  const previous = selectedIndex > 0 ? ordered[selectedIndex - 1] : undefined;
  const diff = selected && previous ? diffLines(previous.contentMarkdown, selected.contentMarkdown) : [];

  const submitRevision = async () => {
    setSaving(true);
    try {
      const updated = await createRevision(item.id, {
        title,
        contentMarkdown: content,
        changeNote: changeNote.trim() || undefined,
        baseRevision: item.currentRevision ?? item.revisionCount ?? 1
      });
      onRevised(updated);
      setEditing(false);
      showToast(`Revision v${updated.currentRevision ?? "new"} saved and returned to review.`);
    } catch (error) {
      showToast(readErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="panel-loading"><LoaderCircle className="spin" />Loading revisions…</div>;

  return (
    <div className="revision-panel">
      <div className="panel-toolbar">
        <div>
          <span className="eyebrow">Immutable history</span>
          <h3>{ordered.length} {ordered.length === 1 ? "revision" : "revisions"}</h3>
        </div>
        <button className="action" type="button" onClick={() => setEditing((value) => !value)}>
          <PencilLine size={15} />{editing ? "Cancel editing" : "Create revision"}
        </button>
      </div>

      {editing && (
        <div className="revision-editor">
          <label>Title<input value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Markdown<textarea value={content} rows={12} maxLength={12_000} onChange={(event) => setContent(event.target.value)} /></label>
          <label>Change note<input value={changeNote} maxLength={160} placeholder="What changed and why?" onChange={(event) => setChangeNote(event.target.value)} /></label>
          <button className="action action--primary" type="button" disabled={saving || !title.trim() || !content.trim()} onClick={() => void submitRevision()}>
            {saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}
            Save as v{(item.currentRevision ?? item.revisionCount ?? 1) + 1}
          </button>
        </div>
      )}

      <div className="revision-layout">
        <ol className="revision-list">
          {[...ordered].reverse().map((revision) => (
            <li key={revision.id}>
              <button className={selected?.id === revision.id ? "active" : ""} type="button" onClick={() => setSelectedVersion(revision.revision)}>
                <strong>v{revision.revision}</strong>
                <span>{revision.changeNote || (revision.authorKind === "migration" ? "Imported from v0.1" : "Content revision")}</span>
                <time>{formatRelativeDate(revision.createdAt)}</time>
              </button>
            </li>
          ))}
        </ol>
        <div className="revision-diff">
          {selected && previous ? (
            <>
              <div className="diff-heading">Changes from v{previous.revision} to v{selected.revision}</div>
              <pre tabIndex={0}>{diff.map((line, index) => (
                <span className={`diff-line diff-line--${line.type}`} key={`${index}-${line.value}`}>
                  <b>{line.type === "added" ? "+" : line.type === "removed" ? "−" : " "}</b>{line.value || " "}
                </span>
              ))}</pre>
            </>
          ) : selected ? (
            <MarkdownBody content={selected.contentMarkdown} focusScrollableRegions />
          ) : (
            <p>No revision history is available yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

interface DetailDrawerProps {
  item: DumpItem;
  recipes: RecipeSummary[];
  onClose: () => void;
  onUpdated: (item: DumpItem) => void;
  onDelete: (item: DumpItem) => void;
  showToast: (message: string) => void;
}

function DetailDrawer({ item, recipes, onClose, onUpdated, onDelete, showToast }: DetailDrawerProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const destinationTabsRef = useRef<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<DetailTab>("preview");
  const [destination, setDestination] = useState<Destination>(defaultDestinationOf(item));
  const [representation, setRepresentation] = useState<Representation | null>(null);
  const [representationLoading, setRepresentationLoading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [revisions, setRevisions] = useState<ArtifactRevision[]>([]);
  const [revisionsLoading, setRevisionsLoading] = useState(false);
  const [findings, setFindings] = useState<SecretFinding[]>(item.secretFindings ?? []);
  const [transitioning, setTransitioning] = useState(false);
  const recipe = recipes.find((candidate) => candidate.id === item.recipeId);
  const status = statusOf(item);
  const destinations = destinationsOf(item);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [onClose]);

  useEffect(() => {
    setDestination(defaultDestinationOf(item));
    setRepresentation(null);
    setFindings(item.secretFindings ?? []);
  }, [item.id, item.currentRevision, item.secretFindings]);

  useEffect(() => {
    if (tab !== "preview") return;
    let cancelled = false;
    setRepresentationLoading(true);
    void getRepresentation(item.id, destination)
      .then((value) => {
        if (!cancelled) setRepresentation(value);
      })
      .catch((error) => {
        if (!cancelled) showToast(readErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setRepresentationLoading(false);
      });
    return () => { cancelled = true; };
  }, [destination, item.id, item.currentRevision, showToast, tab]);

  useEffect(() => {
    if (tab !== "revisions") return;
    let cancelled = false;
    setRevisionsLoading(true);
    void getRevisions(item.id)
      .then((value) => {
        if (!cancelled) setRevisions(value);
      })
      .catch((error) => {
        if (!cancelled) showToast(readErrorMessage(error));
      })
      .finally(() => {
        if (!cancelled) setRevisionsLoading(false);
      });
    return () => { cancelled = true; };
  }, [item.id, item.currentRevision, showToast, tab]);

  useEffect(() => {
    if (tab !== "safety") return;
    let cancelled = false;
    void getFindings(item.id)
      .then((value) => { if (!cancelled) setFindings(value); })
      .catch((error) => { if (!cancelled) showToast(readErrorMessage(error)); });
    return () => { cancelled = true; };
  }, [item.id, showToast, tab]);

  const performCopy = async (format: CopyFormat) => {
    if (!representation) return;
    setCopying(true);
    try {
      const actualFormat = await copyRepresentation(representation, format);
      const updated = await recordCopy(item.id, representation, actualFormat);
      onUpdated(updated);
      showToast(`Copied for ${destinationLabel(destination)} and recorded in the delivery history.`);
    } catch (error) {
      showToast(readErrorMessage(error));
    } finally {
      setCopying(false);
    }
  };

  const performTransition = async (nextStatus: LifecycleStatus) => {
    setTransitioning(true);
    try {
      const updated = await transitionItem(item.id, nextStatus);
      onUpdated(updated);
      showToast(nextStatus === "reviewed" ? "Deliverable reviewed." : nextStatus === "done" ? "Deliverable completed." : "Deliverable reopened.");
    } catch (error) {
      showToast(readErrorMessage(error));
    } finally {
      setTransitioning(false);
    }
  };

  const acknowledge = async (findingId: string) => {
    try {
      const updated = await acknowledgeFinding(item.id, findingId);
      onUpdated(updated);
      setFindings(updated.secretFindings ?? []);
      setRepresentation(null);
      showToast("Safety warning acknowledged. Copy policy will be re-evaluated.");
    } catch (error) {
      showToast(readErrorMessage(error));
    }
  };

  const provenance = item.provenance;
  const provenanceFiles = provenance?.referencedFiles ?? provenance?.files ?? [];
  const emailSubject = typeof representation?.metadata?.subject === "string"
    ? representation.metadata.subject
    : null;

  function handleDestinationKeyDown(
    event: ReactKeyboardEvent<HTMLButtonElement>,
    index: number
  ): void {
    const nextIndex = nextRovingTabIndex(event.key, index, destinations.length);
    if (nextIndex === null) return;
    event.preventDefault();
    const nextDestination = destinations[nextIndex];
    const nextTab = destinationTabsRef.current?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex];
    if (!nextDestination || !nextTab) return;
    setDestination(nextDestination);
    nextTab.focus();
  }

  return (
    <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}>
      <section className="detail-drawer delivery-drawer" role="dialog" aria-modal="true" aria-labelledby="detail-title" onKeyDown={(event) => { if (event.key === "Escape") onClose(); keepFocusInside(event); }}>
        <div className="detail-drawer__header delivery-drawer__header">
          <div>
            <span className={`status-pill status-pill--${status}`}><CircleDot size={11} />{STATUS_META[status].label}</span>
            <span className="recipe-badge">{recipe?.name ?? item.recipeId ?? item.kind}</span>
          </div>
          <button ref={closeRef} className="icon-action" type="button" onClick={onClose} aria-label="Close detail"><X size={19} /></button>
        </div>

        <div className="delivery-drawer__intro">
          <h2 id="detail-title">{item.title}</h2>
          <div className="detail-byline">
            <span><FolderClosed size={14} />{item.project || "General"}</span>
            <span><History size={14} />v{item.currentRevision ?? 1} of {item.revisionCount ?? 1}</span>
            <span>{formatExactDate(item.updatedAt)}</span>
          </div>
        </div>

        <nav className="detail-tabs" aria-label="Deliverable detail">
          {(["preview", "revisions", "provenance", "safety"] as DetailTab[]).map((value) => (
            <button className={tab === value ? "active" : ""} type="button" onClick={() => setTab(value)} key={value}>
              {value === "preview" && <Eye size={15} />}
              {value === "revisions" && <History size={15} />}
              {value === "provenance" && <GitBranch size={15} />}
              {value === "safety" && <ShieldAlert size={15} />}
              {value}{value === "safety" && findings.filter((finding) => finding.status === "open").length > 0 ? ` · ${findings.filter((finding) => finding.status === "open").length}` : ""}
            </button>
          ))}
        </nav>

        <div className="detail-drawer__scroll delivery-drawer__content">
          {tab === "preview" && (
            <div className="destination-workbench">
              <div ref={destinationTabsRef} className="destination-switcher" role="tablist" aria-label="Copy destination">
                {destinations.map((value, index) => {
                  const Icon = DESTINATION_ICONS[value];
                  return (
                    <button
                      id={`destination-tab-${item.id}-${value}`}
                      className={destination === value ? "active" : ""}
                      type="button"
                      role="tab"
                      aria-controls={`destination-panel-${item.id}`}
                      aria-selected={destination === value}
                      tabIndex={destination === value ? 0 : -1}
                      onClick={() => setDestination(value)}
                      onKeyDown={(event) => handleDestinationKeyDown(event, index)}
                      key={value}
                    >
                      <Icon size={15} />{destinationLabel(value)}
                    </button>
                  );
                })}
              </div>

              <div
                id={`destination-panel-${item.id}`}
                className="destination-preview"
                role="tabpanel"
                aria-labelledby={`destination-tab-${item.id}-${destination}`}
                aria-busy={representationLoading}
              >
                <div className="destination-preview__label">
                  <span>Exact {destinationLabel(destination)} output</span>
                  {emailSubject ? <button type="button" onClick={() => void copyText(emailSubject).then(() => showToast("Email subject copied.")).catch((error) => showToast(readErrorMessage(error)))} title="Copy email subject"><strong>Subject:</strong> {emailSubject} <Copy size={12} /></button> : null}
                </div>
                {representationLoading ? (
                  <div className="panel-loading" role="status"><LoaderCircle className="spin" />Rendering safely…</div>
                ) : representation ? (
                  destination === "email" && representation.htmlText ? (
                    <div className="email-preview" dangerouslySetInnerHTML={{ __html: representation.htmlText }} />
                  ) : destination === "github" || destination === "markdown" ? (
                    <MarkdownBody className="markdown-body--detail" content={representation.markdownText ?? representation.plainText} focusScrollableRegions />
                  ) : (
                    <pre className={`text-preview text-preview--${destination}`} tabIndex={0}>{destination === "slack" ? representation.markdownText ?? representation.plainText : representation.plainText}</pre>
                  )
                ) : (
                  <p>Representation unavailable.</p>
                )}
              </div>

              {representation && (representation.warnings.length > 0 || representation.blockReasons.length > 0) && (
                <div className={`representation-warnings ${representation.copyAllowed ? "" : "representation-warnings--blocked"}`}>
                  <AlertTriangle size={18} />
                  <div>
                    {representation.blockReasons.map((reason) => <p key={reason}>{reason}</p>)}
                    {representation.warnings.map((warning) => <p key={warning}>{warning}</p>)}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === "revisions" && (
            <RevisionPanel
              item={item}
              revisions={revisions}
              loading={revisionsLoading}
              onRevised={(updated) => {
                onUpdated(updated);
                void getRevisions(item.id).then(setRevisions);
              }}
              showToast={showToast}
            />
          )}

          {tab === "provenance" && (
            <div className="provenance-panel">
              <div className="panel-heading"><span className="eyebrow">Source trail</span><h3>Where this deliverable came from</h3></div>
              {provenance ? (
                <dl className="provenance-grid">
                  <div><dt>Client</dt><dd>{provenance.sourceClient}{provenance.sourceClientVersion ? ` ${provenance.sourceClientVersion}` : ""}</dd></div>
                  <div><dt>Agent / model</dt><dd>{[provenance.agentName, provenance.model].filter(Boolean).join(" · ") || "Not reported"}</dd></div>
                  <div><dt>Repository</dt><dd>{provenance.repoRoot ?? provenance.cwd ?? "Not reported"}</dd></div>
                  <div><dt>Branch</dt><dd>{provenance.branch ?? "Not reported"}</dd></div>
                  <div><dt>Commit</dt><dd className="mono-value">{provenance.commitSha?.slice(0, 12) ?? "Not reported"}{provenance.repoDirty ? " · dirty" : ""}</dd></div>
                  <div><dt>Session</dt><dd className="mono-value">{provenance.sessionId ?? "Not reported"}</dd></div>
                  <div><dt>Capture</dt><dd>{provenance.captureMethod?.replace("_", " ") ?? "client supplied"} · {provenance.verificationStatus ?? "unverified"}</dd></div>
                </dl>
              ) : <div className="panel-empty"><GitBranch size={28} /><p>This legacy item has no detailed provenance.</p></div>}
              {provenanceFiles.length ? (
                <div className="referenced-files"><h4>Referenced files</h4><ul>{provenanceFiles.map((file) => <li key={`${file.path}-${file.lineStart}`}><code>{file.path}</code>{file.lineStart ? `:${file.lineStart}${file.lineEnd ? `–${file.lineEnd}` : ""}` : ""}</li>)}</ul></div>
              ) : null}
            </div>
          )}

          {tab === "safety" && (
            <div className="safety-panel">
              <div className="panel-heading"><span className="eyebrow">Local safety gate</span><h3>{findings.length ? "Review detected risks" : "No warnings detected"}</h3></div>
              {!findings.length ? (
                <div className="panel-empty panel-empty--safe"><LockKeyhole size={28} /><p>The current revision passed DraftRelay’s configured secret checks.</p></div>
              ) : (
                <ul className="finding-list">{findings.map((finding) => (
                  <li className={`finding finding--${finding.severity}`} key={finding.id}>
                    <ShieldAlert size={18} />
                    <div><strong>{finding.label ?? finding.ruleId}</strong><span>Line {finding.lineNumber} · {finding.severity} · {finding.redactedPreview}</span></div>
                    {finding.status === "open" ? <button className="action" type="button" onClick={() => void acknowledge(finding.id)}>Acknowledge</button> : <span className="acknowledged"><Check size={14} />Acknowledged</span>}
                  </li>
                ))}</ul>
              )}
            </div>
          )}
        </div>

        <footer className="detail-drawer__footer delivery-drawer__footer">
          {tab === "preview" && (
            <>
              <button className="action action--primary" type="button" disabled={copying || representationLoading || !representation?.copyAllowed} onClick={() => void performCopy(destination === "markdown" || destination === "github" ? "markdown" : "rich")}>
                {copying ? <LoaderCircle className="spin" size={16} /> : <ClipboardCopy size={16} />}
                Copy for {destinationLabel(destination)}
              </button>
              <button className="action" type="button" disabled={copying || !representation?.copyAllowed} onClick={() => void performCopy("text")}><Copy size={15} />Copy plain</button>
            </>
          )}
          <span className="action-spacer" />
          {status === "new" && <button className="action" disabled={transitioning} type="button" onClick={() => void performTransition("reviewed")}><Eye size={15} />Mark reviewed</button>}
          {status !== "done" ? <button className="icon-action" disabled={transitioning} type="button" onClick={() => void performTransition("done")} aria-label="Complete deliverable"><CheckCircle2 size={17} /></button> : <button className="icon-action" disabled={transitioning} type="button" onClick={() => void performTransition("new")} aria-label="Reopen deliverable"><RotateCcw size={17} /></button>}
          <button className="icon-action icon-action--danger" type="button" onClick={() => onDelete(item)} aria-label="Delete permanently"><Trash2 size={17} /></button>
        </footer>
      </section>
    </div>
  );
}

interface SettingsDialogProps {
  projects: ProjectSummary[];
  notificationPermission: NotificationPermission | "unsupported";
  onEnableNotifications: () => void;
  onClose: () => void;
  showToast: (message: string) => void;
}

function SettingsDialog({ projects, notificationPermission, onEnableNotifications, onClose, showToast }: SettingsDialogProps) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [project, setProject] = useState(projects[0]?.name ?? "General");
  const [policy, setPolicy] = useState<ProjectPolicy | null>(null);
  const [originalPolicy, setOriginalPolicy] = useState<ProjectPolicy | null>(null);
  const [patterns, setPatterns] = useState<ProjectSecretPattern[]>([]);
  const [patternLabel, setPatternLabel] = useState("");
  const [patternValue, setPatternValue] = useState("");
  const [patternKind, setPatternKind] = useState<ProjectSecretPattern["patternKind"]>("literal");
  const [patternSeverity, setPatternSeverity] = useState<ProjectSecretPattern["severity"]>("high");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingPattern, setSavingPattern] = useState(false);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([getProjectPolicy(project), getProjectSecretPatterns(project)])
      .then(([value, nextPatterns]) => { if (!cancelled) { setPolicy(value); setOriginalPolicy(value); setPatterns(nextPatterns); } })
      .catch((error) => { if (!cancelled) showToast(readErrorMessage(error)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [project, showToast]);

  const save = async () => {
    if (!policy) return;
    setSaving(true);
    try {
      const patch: Partial<ProjectPolicy> = {};
      for (const key of ["defaultDestination", "allowedDestinations", "secretMode", "requireSecretAck", "requireReviewBeforeCopy", "copyBehavior", "retentionDays"] as const) {
        if (JSON.stringify(policy[key]) !== JSON.stringify(originalPolicy?.[key])) {
          (patch as Record<string, unknown>)[key] = policy[key];
        }
      }
      if (Object.keys(patch).length === 0) {
        showToast(`${project} policy is already up to date.`);
        return;
      }
      const updated = await updateProjectPolicy(project, patch);
      setPolicy(updated);
      setOriginalPolicy(updated);
      showToast(`${project} output policy saved.`);
    } catch (error) {
      showToast(readErrorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const addPattern = async () => {
    if (!patternLabel.trim() || !patternValue.trim()) return;
    setSavingPattern(true);
    try {
      const created = await createProjectSecretPattern(project, {
        label: patternLabel.trim(),
        pattern: patternValue,
        patternKind,
        severity: patternSeverity
      });
      setPatterns((current) => [...current, created]);
      setPatternLabel("");
      setPatternValue("");
      showToast("Project secret pattern added.");
    } catch (error) {
      showToast(readErrorMessage(error));
    } finally {
      setSavingPattern(false);
    }
  };

  const removePattern = async (patternId: string) => {
    try {
      await deleteProjectSecretPattern(project, patternId);
      setPatterns((current) => current.filter((pattern) => pattern.id !== patternId));
      showToast("Project secret pattern removed.");
    } catch (error) {
      showToast(readErrorMessage(error));
    }
  };

  return (
    <div className="confirm-backdrop settings-backdrop" role="presentation">
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={(event) => { if (event.key === "Escape") onClose(); keepFocusInside(event); }}>
        <header><div><span className="eyebrow">Local preferences</span><h2 id="settings-title">Delivery policy</h2></div><button ref={closeRef} className="icon-action" type="button" onClick={onClose} aria-label="Close settings"><X size={18} /></button></header>

        <div className="settings-section notification-setting">
          <div><BellRing size={20} /><span><strong>Arrival notifications</strong><small>Know when an agent publishes a deliverable.</small></span></div>
          <button className="action" type="button" disabled={notificationPermission === "unsupported" || notificationPermission === "granted"} onClick={onEnableNotifications}>
            {notificationPermission === "granted" ? <><Check size={15} />Enabled</> : notificationPermission === "denied" ? "Blocked by browser" : notificationPermission === "unsupported" ? "Unsupported" : "Enable"}
          </button>
        </div>

        <div className="settings-section">
          <label className="settings-field">Project<select value={project} onChange={(event) => setProject(event.target.value)}>{projects.map((value) => <option key={value.name}>{value.name}</option>)}</select></label>
          {loading || !policy ? <div className="panel-loading"><LoaderCircle className="spin" />Loading policy…</div> : (
            <div className="policy-grid">
              <label className="settings-field">Default destination<select value={policy.defaultDestination} onChange={(event) => setPolicy({ ...policy, defaultDestination: event.target.value as Destination })}>{policy.allowedDestinations.map((value) => <option value={value} key={value}>{destinationLabel(value)}</option>)}</select></label>
              <label className="settings-field">Secret mode<select value={policy.secretMode} onChange={(event) => setPolicy({ ...policy, secretMode: event.target.value as ProjectPolicy["secretMode"] })}><option value="off">Off</option><option value="warn">Warn</option><option value="block_high">Block high confidence</option><option value="block_all">Block every finding</option></select></label>
              <label className="settings-field">After copy<select value={policy.copyBehavior} onChange={(event) => setPolicy({ ...policy, copyBehavior: event.target.value as ProjectPolicy["copyBehavior"] })}><option value="no_change">Keep current status</option><option value="mark_copied">Mark copied</option><option value="mark_done">Complete automatically</option></select></label>
              <label className="settings-field">Retention after completion<input type="number" min="1" max="3650" value={policy.retentionDays ?? ""} placeholder="Never expire" onChange={(event) => setPolicy({ ...policy, retentionDays: event.target.value ? Number(event.target.value) : null })} /></label>
              <fieldset className="destination-policy"><legend>Allowed destinations</legend>{(["slack", "email", "github", "plain", "markdown"] as Destination[]).map((value) => { const checked = policy.allowedDestinations.includes(value); return <label key={value}><input type="checkbox" checked={checked} disabled={checked && policy.allowedDestinations.length === 1} onChange={(event) => { const allowedDestinations = event.target.checked ? [...policy.allowedDestinations, value] : policy.allowedDestinations.filter((candidate) => candidate !== value); setPolicy({ ...policy, allowedDestinations, defaultDestination: allowedDestinations.includes(policy.defaultDestination) ? policy.defaultDestination : allowedDestinations[0]! }); }} /><span>{destinationLabel(value)}</span></label>; })}</fieldset>
              <label className="settings-check"><input type="checkbox" checked={policy.requireReviewBeforeCopy} onChange={(event) => setPolicy({ ...policy, requireReviewBeforeCopy: event.target.checked })} /><span><strong>Require review before copy</strong><small>New agent output cannot leave the outbox until reviewed.</small></span></label>
              <label className="settings-check"><input type="checkbox" checked={policy.requireSecretAck} onChange={(event) => setPolicy({ ...policy, requireSecretAck: event.target.checked })} /><span><strong>Require warning acknowledgement</strong><small>Open safety warnings block destination copies.</small></span></label>
            </div>
          )}
        </div>
        <div className="settings-section pattern-settings">
          <div className="pattern-settings__heading"><div><span className="eyebrow">Project vocabulary</span><h3>Custom secret patterns</h3><p>Literal text or simple <code>*</code> globs are scanned locally. Raw matches never appear in the UI.</p></div><ShieldAlert size={22} /></div>
          <div className="pattern-editor">
            <label className="settings-field">Label<input value={patternLabel} maxLength={80} placeholder="Internal staging token" onChange={(event) => setPatternLabel(event.target.value)} /></label>
            <label className="settings-field">Match type<select value={patternKind} onChange={(event) => setPatternKind(event.target.value as ProjectSecretPattern["patternKind"])}><option value="literal">Exact literal</option><option value="glob">Simple glob</option></select></label>
            <label className="settings-field">Severity<select value={patternSeverity} onChange={(event) => setPatternSeverity(event.target.value as ProjectSecretPattern["severity"])}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="critical">Critical</option></select></label>
            <label className="settings-field pattern-editor__value">Pattern<input value={patternValue} maxLength={500} type="password" autoComplete="off" placeholder={patternKind === "glob" ? "staging-secret-*" : "private marker"} onChange={(event) => setPatternValue(event.target.value)} /></label>
            <button className="action" type="button" disabled={savingPattern || !patternLabel.trim() || !patternValue.trim()} onClick={() => void addPattern()}>{savingPattern ? <LoaderCircle className="spin" size={14} /> : <ShieldAlert size={14} />}Add scanner rule</button>
          </div>
          {patterns.length ? <ul className="pattern-list">{patterns.map((pattern) => <li key={pattern.id}><div><strong>{pattern.label}</strong><span>{pattern.patternKind} · {pattern.severity} · pattern hidden</span></div><button className="icon-action icon-action--danger" type="button" onClick={() => void removePattern(pattern.id)} aria-label={`Remove ${pattern.label}`}><Trash2 size={14} /></button></li>)}</ul> : <p className="pattern-empty">No custom patterns for {project}. Built-in key and token detectors still apply.</p>}
        </div>
        <footer><button className="action" type="button" onClick={onClose}>Close</button><button className="action action--primary" type="button" disabled={!policy || saving} onClick={() => void save()}>{saving ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Save policy</button></footer>
      </section>
    </div>
  );
}

interface DeleteDialogProps {
  item: DumpItem;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteDialog({ item, busy, onCancel, onConfirm }: DeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
  return (
    <div className="confirm-backdrop" role="presentation">
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title" aria-describedby="delete-description" onKeyDown={(event) => { if (event.key === "Escape" && !busy) onCancel(); keepFocusInside(event); }}>
        <span className="confirm-dialog__icon" aria-hidden="true"><Trash2 size={22} /></span>
        <span className="eyebrow">Permanent action</span>
        <h2 id="delete-title">Delete this deliverable?</h2>
        <p id="delete-description">“{item.title}” and every immutable revision will be removed. This cannot be undone.</p>
        <div className="confirm-dialog__actions"><button ref={cancelRef} className="action" type="button" onClick={onCancel} disabled={busy}>Keep it</button><button className="action action--danger" type="button" onClick={onConfirm} disabled={busy}>{busy && <LoaderCircle className="spin" size={16} />}{busy ? "Deleting…" : "Delete permanently"}</button></div>
      </section>
    </div>
  );
}

export interface AppProps {
  deployment?: "local" | "cloud";
  productName?: string;
  onOpenAccount?: () => void;
}

function App({
  deployment = "local",
  productName = "DraftRelay",
  onOpenAccount
}: AppProps) {
  const [items, setItems] = useState<DumpItem[]>([]);
  const [facets, setFacets] = useState<ApiFacets>({});
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [recipes, setRecipes] = useState<RecipeSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [view, setView] = useState<LifecycleView>("new");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [health, setHealth] = useState<HealthState>("checking");
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [selected, setSelected] = useState<DumpItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<DumpItem | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [busyItemId, setBusyItemId] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | "unsupported">(
    "Notification" in window ? Notification.permission : "unsupported"
  );
  const requestController = useRef<AbortController | null>(null);
  const toastSequence = useRef(0);
  const initialItemId = useRef(new URLSearchParams(window.location.search).get("item"));
  const seenIds = useRef<Set<string> | null>(null);
  const lastSuccessfulLoadAt = useRef<number | null>(null);
  const filterCloseRef = useRef<HTMLButtonElement | null>(null);
  const filterOpenButtonRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const loadedItemCount = useRef(0);

  useEffect(() => {
    loadedItemCount.current = items.length;
  }, [items.length]);

  const showToast = useCallback((message: string, action?: Pick<ToastState, "action" | "actionLabel">) => {
    toastSequence.current += 1;
    setToast({ id: toastSequence.current, message, ...action });
  }, []);

  const updateLocalItem = useCallback((updated: DumpItem) => {
    setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
    setSelected((current) => current?.id === updated.id ? updated : current);
  }, []);

  useEffect(() => {
    const timeout = window.setTimeout(() => setDebouncedQuery(query.trim()), 260);
    return () => window.clearTimeout(timeout);
  }, [query]);

  const loadItems = useCallback(async (silent = false, cursor?: string) => {
    const loadStartedAt = Date.now();
    const appending = cursor !== undefined;
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    if (appending) setLoadingMore(true);
    else if (silent) setRefreshing(true);
    else setLoading(true);

    const params = new URLSearchParams();
    params.set("archived", "all");
    params.set("limit", "50");
    if (view !== "all") params.set("status", view);
    if (debouncedQuery) params.set("q", debouncedQuery);
    if (filters.project) params.set("project", filters.project);
    if (filters.recipe) params.set("recipe", filters.recipe);
    if (filters.tag) params.set("tag", filters.tag);
    if (cursor) params.set("cursor", cursor);

    try {
      const response = await listItems(params, controller.signal);
      if (controller.signal.aborted) return;
      let nextItems = Array.isArray(response.items) ? response.items : [];
      let finalCursor = response.nextCursor;
      if (silent && !appending) {
        const targetCount = loadedItemCount.current;
        while (finalCursor && nextItems.length < targetCount) {
          const pageParams = new URLSearchParams(params);
          pageParams.set("cursor", finalCursor);
          const page = await listItems(pageParams, controller.signal);
          if (controller.signal.aborted) return;
          nextItems = [...nextItems, ...(Array.isArray(page.items) ? page.items : [])];
          finalCursor = page.nextCursor;
        }
      }
      if (appending) {
        setItems((current) => {
          const known = new Set(current.map((item) => item.id));
          return [...current, ...nextItems.filter((item) => !known.has(item.id))];
        });
        nextItems.forEach((item) => seenIds.current?.add(item.id));
      } else if (seenIds.current === null) {
        seenIds.current = new Set(nextItems.map((item) => item.id));
        setItems(nextItems);
      } else {
        const arrivalThreshold = lastSuccessfulLoadAt.current ?? loadStartedAt;
        const arrivals = nextItems.filter((item) =>
          !seenIds.current?.has(item.id) && Date.parse(item.createdAt) >= arrivalThreshold
        );
        nextItems.forEach((item) => seenIds.current?.add(item.id));
        if (arrivals.length && document.visibilityState !== "visible") {
          showToast(`${arrivals.length} new ${arrivals.length === 1 ? "deliverable" : "deliverables"} arrived.`);
        }
        if (arrivals.length && notificationPermission === "granted") {
          const first = arrivals[0]!;
          const notification = new Notification(first.title, {
            body: `${first.project || "General"} · ${recipes.find((recipe) => recipe.id === first.recipeId)?.name ?? first.recipeId ?? first.kind}`,
            tag: first.id
          });
          notification.onclick = () => {
            window.focus();
            setSelected(first);
            updateItemQuery(first.id);
            notification.close();
          };
        }
        setItems(nextItems);
      }
      setNextCursor(finalCursor ?? null);
      lastSuccessfulLoadAt.current = loadStartedAt;
      setFacets(response.facets ?? {});
      setError(null);
      setLastUpdated(new Date());
    } catch (loadError) {
      if (!controller.signal.aborted) setError(readErrorMessage(loadError));
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    }
  }, [debouncedQuery, filters.project, filters.recipe, filters.tag, notificationPermission, recipes, showToast, view]);

  useEffect(() => {
    void Promise.all([
      getRecipes().catch(() => [] as RecipeSummary[]),
      getProjects().catch(() => [] as ProjectSummary[])
    ]).then(([recipeList, projectList]) => {
      setRecipes(recipeList);
      setProjects(projectList);
    });
  }, []);

  useEffect(() => {
    void loadItems(false);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadItems(true);
    }, POLL_INTERVAL_MS);
    return () => {
      window.clearInterval(interval);
      requestController.current?.abort();
    };
  }, [loadItems]);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch("/api/health", { cache: "no-store" });
        if (!cancelled) setHealth(response.ok ? "online" : "offline");
      } catch {
        if (!cancelled) setHealth("offline");
      }
    };
    void check();
    const interval = window.setInterval(check, 30_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 6_000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const itemId = initialItemId.current;
    if (!itemId) return;
    const controller = new AbortController();
    void getItem(itemId, controller.signal)
      .then((item) => {
        if (controller.signal.aborted) return;
        initialItemId.current = null;
        setView(statusOf(item));
        setSelected(item);
      })
      .catch(() => {
        if (!controller.signal.aborted) updateItemQuery(null);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const mobileViewport = window.matchMedia("(max-width: 900px)");
    const closeOnDesktop = () => { if (!mobileViewport.matches) setFiltersOpen(false); };
    mobileViewport.addEventListener("change", closeOnDesktop);
    return () => mobileViewport.removeEventListener("change", closeOnDesktop);
  }, []);

  useEffect(() => {
    if (!filtersOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = window.requestAnimationFrame(() => filterCloseRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = previousOverflow;
      filterOpenButtonRef.current?.focus();
    };
  }, [filtersOpen]);

  const copyItem = useCallback(async (item: DumpItem, destination = defaultDestinationOf(item)) => {
    setBusyItemId(item.id);
    try {
      const representation = await getRepresentation(item.id, destination);
      const format = await copyRepresentation(
        representation,
        destination === "markdown" || destination === "github" ? "markdown" : "rich"
      );
      const updated = await recordCopy(item.id, representation, format);
      updateLocalItem(updated);
      showToast(`Copied for ${destinationLabel(destination)}.`);
      if (view !== "all" && statusOf(updated) !== view) await loadItems(true);
    } catch (copyError) {
      showToast(readErrorMessage(copyError));
    } finally {
      setBusyItemId(null);
    }
  }, [loadItems, showToast, updateLocalItem, view]);

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, select, [contenteditable='true']") ?? false;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "c" && items[0]) {
        event.preventDefault();
        void copyItem(items[0]);
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [copyItem, items]);

  const transition = useCallback(async (item: DumpItem, status: LifecycleStatus) => {
    setBusyItemId(item.id);
    try {
      const updated = await transitionItem(item.id, status);
      updateLocalItem(updated);
      showToast(status === "reviewed" ? "Deliverable reviewed." : status === "done" ? "Deliverable completed." : "Deliverable reopened.");
      if (view !== "all" && status !== view) await loadItems(true);
    } catch (transitionError) {
      showToast(readErrorMessage(transitionError));
    } finally {
      setBusyItemId(null);
    }
  }, [loadItems, showToast, updateLocalItem, view]);

  const removeItem = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await deleteItem(deleteTarget.id);
      setItems((current) => current.filter((item) => item.id !== deleteTarget.id));
      if (selected?.id === deleteTarget.id) {
        setSelected(null);
        updateItemQuery(null);
      }
      setDeleteTarget(null);
      showToast("Deliverable and revision history deleted permanently.");
    } catch (deleteError) {
      showToast(readErrorMessage(deleteError));
    } finally {
      setDeleting(false);
    }
  }, [deleteTarget, selected?.id, showToast]);

  const enableNotifications = async () => {
    if (!("Notification" in window)) return;
    setNotificationPermission(await Notification.requestPermission());
  };

  const recipeMap = useMemo(() => new Map(recipes.map((recipe) => [recipe.id, recipe])), [recipes]);
  const options = useMemo(() => ({
    projects: mergeOptions(normalizeFacet(facets.projects ?? facets.project), items.map((item) => item.project), filters.project),
    recipes: mergeOptions(normalizeFacet(facets.recipes ?? facets.recipe), items.map((item) => item.recipeId ?? item.kind), filters.recipe),
    tags: mergeOptions(normalizeFacet(facets.tags ?? facets.tag), items.flatMap((item) => item.tags), filters.tag)
  }), [facets, filters, items]);
  const statusCounts = useMemo(() => {
    const counts = new Map<string, number>();
    normalizeFacet(facets.statuses ?? facets.status).forEach((entry) => counts.set(entry.value, entry.count ?? 0));
    return counts;
  }, [facets.status, facets.statuses]);
  const activeFilterCount = [filters.project, filters.recipe, filters.tag].filter(Boolean).length;
  const hasConstraints = Boolean(query || activeFilterCount);

  const openDetail = (item: DumpItem) => {
    setSelected(item);
    updateItemQuery(item.id);
  };
  const closeDetail = () => {
    setSelected(null);
    updateItemQuery(null);
  };

  return (
    <div className="app-shell outbox-shell">
      <a className="app-skip-link" href="#draftrelay-main">Skip to deliverables</a>
      <header className="masthead" inert={filtersOpen ? true : undefined} aria-hidden={filtersOpen ? true : undefined}>
        <a className="wordmark" href={deployment === "cloud" ? "/app" : "/"} aria-label={`${productName} home`}><span className="wordmark__mark" aria-hidden="true">D/</span><span><strong>{productName}</strong><small>{deployment === "cloud" ? "review inbox" : "local review inbox"}</small></span></a>
        <div className="masthead__status">
          <span className={`server-status server-status--${health}`}>{health === "offline" ? <WifiOff size={14} /> : <SquareTerminal size={14} />}<span>{health === "checking" ? "Checking review inbox" : health === "online" ? (deployment === "cloud" ? "Inbox online" : "Local inbox online") : "Inbox offline"}</span></span>
          <span className="masthead__hint">Publish the answer. Not the transcript.</span>
          <button className="icon-action" type="button" onClick={() => setSettingsOpen(true)} aria-label="Open delivery settings"><Settings2 size={17} /></button>
          {onOpenAccount && <button className="icon-action" type="button" onClick={onOpenAccount} aria-label="Open account settings"><UserRound size={17} /></button>}
        </div>
      </header>

      <div className="workspace">
        <aside className={`filter-rail lifecycle-rail ${filtersOpen ? "filter-rail--open" : ""}`} aria-label="Outbox navigation" role={filtersOpen ? "dialog" : undefined} aria-modal={filtersOpen ? true : undefined} onKeyDown={(event) => { if (!filtersOpen) return; if (event.key === "Escape") setFiltersOpen(false); else keepFocusInside(event); }}>
          <div className="filter-rail__heading"><span className="eyebrow">Delivery queue</span><button ref={filterCloseRef} className="icon-action filter-close" type="button" onClick={() => setFiltersOpen(false)} aria-label="Close filters"><X size={18} /></button></div>
          <nav className="tray-switcher lifecycle-switcher" aria-label="Lifecycle status">
            {(Object.keys(STATUS_META) as LifecycleStatus[]).map((status) => (
              <button className={view === status ? "active" : ""} type="button" onClick={() => { setView(status); closeDetail(); }} aria-current={view === status ? "page" : undefined} key={status}>
                {status === "new" && <Inbox size={17} />}{status === "reviewed" && <Eye size={17} />}{status === "copied" && <ClipboardCopy size={17} />}{status === "done" && <CheckCircle2 size={17} />}
                <span><strong>{STATUS_META[status].label}</strong><small>{STATUS_META[status].description}</small></span>
                {statusCounts.has(status) && <b>{statusCounts.get(status)}</b>}
              </button>
            ))}
            <button className={view === "all" ? "active" : ""} type="button" onClick={() => { setView("all"); closeDetail(); }} aria-current={view === "all" ? "page" : undefined}><History size={17} /><span><strong>Everything</strong><small>Full delivery history</small></span></button>
          </nav>

          <div className="rail-divider" />
          <div className="filter-stack">
            <div className="filter-stack__heading"><span>Filter deliverables</span>{activeFilterCount > 0 && <span>{activeFilterCount}</span>}</div>
            <FilterSelect id="project-filter" label="Projects" value={filters.project} options={options.projects} onChange={(project) => setFilters((current) => ({ ...current, project }))} />
            <FilterSelect id="recipe-filter" label="Recipes" value={filters.recipe} options={options.recipes} onChange={(recipe) => setFilters((current) => ({ ...current, recipe }))} />
            <FilterSelect id="tag-filter" label="Tags" value={filters.tag} options={options.tags} onChange={(tag) => setFilters((current) => ({ ...current, tag }))} />
            {activeFilterCount > 0 && <button className="clear-filters" type="button" onClick={() => setFilters(EMPTY_FILTERS)}><X size={14} />Clear filters</button>}
          </div>
          <div className="rail-note"><span className="rail-note__number">⌘⇧C</span><p>Copy the newest visible deliverable without opening it. Press <b>/</b> to search.</p></div>
        </aside>

        {filtersOpen && <button className="filter-scrim" type="button" aria-label="Close filters" onClick={() => setFiltersOpen(false)} />}

        <main id="draftrelay-main" className="main-stage" tabIndex={-1} inert={filtersOpen ? true : undefined} aria-hidden={filtersOpen ? true : undefined}>
          <div className="stage-tools outbox-heading">
            <div className="stage-tools__topline"><div><span className="eyebrow">Human delivery layer</span><h1>{view === "all" ? "Every handoff." : STATUS_META[view].label + "."}</h1></div><p>{view === "new" ? "Fresh work from your agents, waiting for judgment—not buried in terminal scrollback." : view === "reviewed" ? "Approved deliverables ready for their destination." : view === "copied" ? "Outputs already placed on a clipboard, with the destination recorded." : view === "done" ? "Completed handoffs kept out of the way until retention policy clears them." : "A traceable record of what agents produced and humans actually used."}</p></div>
            <div className="search-row"><label className="search-field"><Search size={18} aria-hidden="true" /><span className="sr-only">Search deliverables</span><input ref={searchRef} type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search output, project, branch, or tag…" />{query && <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><X size={16} /></button>}<kbd>/</kbd></label><button ref={filterOpenButtonRef} className="action mobile-filter-button" type="button" onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={16} />Filters{activeFilterCount ? ` · ${activeFilterCount}` : ""}</button><button className="icon-action refresh-button" type="button" onClick={() => void loadItems(true)} disabled={refreshing} aria-label="Refresh deliverables"><RefreshCw className={refreshing ? "spin" : ""} size={17} /></button></div>
          </div>

          <div className="results-bar" aria-live="polite"><span><strong>{items.length}</strong> {items.length === 1 ? "deliverable" : "deliverables"}</span><span className="results-bar__line" /><span>{lastUpdated ? `Updated ${formatRelativeDate(lastUpdated.toISOString())}` : "Waiting for server"}</span>{refreshing && <span className="refresh-label"><LoaderCircle className="spin" size={13} />Syncing</span>}</div>
          {error && <div className="error-banner" role="alert"><WifiOff size={18} /><div><strong>Couldn’t refresh the outbox.</strong><span>{error}</span></div><button type="button" onClick={() => void loadItems(false)}>Try again</button></div>}

          {loading ? (
            <div className="loading-grid" role="status" aria-label="Loading deliverables">{[0, 1, 2, 3].map((key) => <div className="skeleton-card" aria-hidden="true" key={key} />)}</div>
          ) : items.length ? (
            <>
              <section className="clip-grid" aria-label={`${view} deliverables`}>{items.map((item, index) => (
                <div className="clip-grid__item" style={{ "--card-order": index } as CSSProperties} key={item.id}>
                  <ArtifactCard item={item} recipeName={recipeMap.get(item.recipeId ?? "")?.name ?? item.recipeId ?? item.kind} busy={busyItemId === item.id} onOpen={openDetail} onCopy={(target, destination) => void copyItem(target, destination)} onTransition={(target, status) => void transition(target, status)} onDelete={setDeleteTarget} />
                </div>
              ))}</section>
              {nextCursor && (
                <div className="load-more-row">
                  <button className="action" type="button" disabled={loadingMore} onClick={() => void loadItems(false, nextCursor)}>
                    {loadingMore ? <LoaderCircle className="spin" size={15} /> : <History size={15} />}
                    {loadingMore ? "Loading more…" : "Load more deliverables"}
                  </button>
                </div>
              )}
            </>
          ) : (
            <section className="empty-state"><FileText aria-hidden="true" size={32} strokeWidth={1.25} /><h2>{hasConstraints ? "No matching deliverables." : view === "new" ? "The outbox is clear." : `Nothing ${view === "all" ? "here" : view} yet.`}</h2><p>{hasConstraints ? "Try another phrase, project, recipe, or tag." : view === "new" ? "Ask an AI agent to publish a Slack update, client email, decision, incident summary, PR description, or command set." : "Artifacts move here as humans review, copy, and complete them."}</p>{hasConstraints && <button className="action" type="button" onClick={() => { setQuery(""); setFilters(EMPTY_FILTERS); }}>Clear search and filters</button>}</section>
          )}
        </main>
      </div>

      {selected && !deleteTarget && <DetailDrawer item={selected} recipes={recipes} onClose={closeDetail} onUpdated={updateLocalItem} onDelete={setDeleteTarget} showToast={showToast} />}
      {deleteTarget && <DeleteDialog item={deleteTarget} busy={deleting} onCancel={() => setDeleteTarget(null)} onConfirm={() => void removeItem()} />}
      {settingsOpen && <SettingsDialog projects={projects.length ? projects : [{ name: "General" }]} notificationPermission={notificationPermission} onEnableNotifications={() => void enableNotifications()} onClose={() => setSettingsOpen(false)} showToast={showToast} />}

      <div className={`toast ${toast ? "toast--visible" : ""}`} role="status" aria-live="polite">{toast && <><span>{toast.message}</span>{toast.action && <button type="button" onClick={() => void toast.action?.()}><Undo2 size={15} />{toast.actionLabel}</button>}<button className="toast__close" type="button" onClick={() => setToast(null)} aria-label="Dismiss notification"><X size={15} /></button></>}</div>
    </div>
  );
}

export default App;
