"use client";

import { useCallback, useEffect, useState } from "react";
import UsernameField, { type UsernameStatus } from "@/components/UsernameField";
import { StatusBadge } from "@/components/ui/Chips";
import { validatePassword, PASSWORD_HINT } from "@/lib/credentials";

/**
 * SUPER_ADMIN: companies, the branches they own, their COMPANY_ADMIN accounts
 * and which branch admins each one oversees. Everything is checked again on
 * the server (and the allocation table's foreign keys refuse a cross-company
 * allocation outright); this page only offers what is valid.
 */

interface Person {
  id: string;
  name: string;
  email: string;
  username: string | null;
  active: boolean;
}

interface Branch {
  tenantId: string;
  name: string;
  companyName: string | null;
  admins: Person[];
}

interface CompanyAdmin extends Person {
  allocatedAdminIds: string[];
}

interface Company {
  id: string;
  name: string;
  isActive: boolean;
  branches: Branch[];
  companyAdmins: CompanyAdmin[];
}

const input =
  "w-full px-4 py-2.5 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black placeholder:text-ink-muted-light focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors";
/** The size of the action buttons beside it. */
const compactInput =
  "px-3 py-1 bg-ink-surface border border-ink-border rounded font-mono text-sm text-ink-black focus:outline-none focus:border-ink-green focus:ring-1 focus:ring-ink-green/20 transition-colors";
const label = "block text-xs font-mono text-ink-muted uppercase tracking-wide mb-1.5";
const sectionTitle = "text-[11px] font-mono text-ink-muted uppercase tracking-wide";

const branchLabel = (b: Branch) => b.companyName || b.name;
const handles = (people: Person[]) =>
  people.map((p) => (p.username ? `@${p.username}` : p.name)).join(", ") || "no admin";

export default function CompaniesPage() {
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [unassigned, setUnassigned] = useState<Branch[]>([]);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [showNew, setShowNew] = useState(false);

  const load = useCallback(
    () =>
      fetch("/api/admin/companies")
        .then(async (res) => {
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || "Could not load companies");
          setCompanies(data.companies);
          setUnassigned(data.unassignedBranches);
        })
        .catch((e) => setError(e instanceof Error ? e.message : "Network error")),
    []
  );

  useEffect(() => {
    load();
  }, [load]);

  /** One action on one company; reloads on success. Returns whether it worked. */
  const act = async (key: string, companyId: string, body: Record<string, unknown>, done: string) => {
    setError("");
    setSuccess("");
    setBusy(key);
    try {
      const res = await fetch(`/api/admin/companies/${companyId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "That did not save");
        return false;
      }
      setSuccess(done);
      await load();
      return true;
    } catch {
      setError("Network error");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccess("");
    setBusy("create");
    try {
      const res = await fetch("/api/admin/companies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Could not create the company");
        return;
      }
      setSuccess(`Created ${newName.trim()}`);
      setNewName("");
      setShowNew(false);
      await load();
    } catch {
      setError("Network error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="max-w-5xl">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h1 className="font-mono text-lg font-medium text-ink-black">Companies</h1>
          <p className="text-sm text-ink-muted font-mono mt-1">
            A company owns branches. Its company admins see only the branch admins you allocate to them — never
            another company&apos;s, and never this console.
          </p>
        </div>
        <button type="button" className="act act-primary shrink-0" onClick={() => setShowNew((v) => !v)}>
          {showNew ? "Cancel" : "+ New company"}
        </button>
      </div>

      {success && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 bg-ink-green-dim rounded border border-ink-green/20">
          <span className="w-1.5 h-1.5 rounded-full bg-ink-green" />
          <span className="text-xs font-mono text-ink-green">{success}</span>
        </div>
      )}
      {error && (
        <div className="flex items-center gap-2 px-3 py-2 mb-4 bg-red-500/10 rounded border border-red-500/20">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
          <span className="text-xs font-mono text-red-400">{error}</span>
        </div>
      )}

      {showNew && (
        <form onSubmit={create} className="bg-ink-card border border-ink-border rounded p-5 mb-6 flex flex-col sm:flex-row gap-3 sm:items-end">
          <div className="flex-1">
            <label htmlFor="new-company-name" className={label}>Company name</label>
            <input
              id="new-company-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={100}
              required
              className={input}
              placeholder="e.g. Electro - City"
            />
          </div>
          <button type="submit" className="act act-primary" disabled={busy !== null || !newName.trim()}>
            {busy === "create" ? "Creating…" : "Create company"}
          </button>
        </form>
      )}

      {companies === null ? (
        <div className="text-sm font-mono text-ink-muted py-8 text-center">Loading…</div>
      ) : companies.length === 0 ? (
        <div className="text-sm font-mono text-ink-muted py-8 text-center">No companies yet.</div>
      ) : (
        <div className="space-y-6">
          {companies.map((c) => (
            <CompanyCard key={c.id} company={c} unassigned={unassigned} busy={busy} act={act} />
          ))}
        </div>
      )}

      {unassigned.length > 0 && (
        <div className="mt-8">
          <p className={sectionTitle}>Branches in no company</p>
          <ul className="mt-2 text-sm font-mono text-ink-black space-y-1">
            {unassigned.map((b) => (
              <li key={b.tenantId}>
                {branchLabel(b)} <span className="text-ink-muted">· {handles(b.admins)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

type Act = (key: string, companyId: string, body: Record<string, unknown>, done: string) => Promise<boolean>;

function CompanyCard({
  company: c,
  unassigned,
  busy,
  act,
}: {
  company: Company;
  unassigned: Branch[];
  busy: string | null;
  act: Act;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(c.name);
  const [attach, setAttach] = useState("");
  const [showAdminForm, setShowAdminForm] = useState(false);
  const branchAdmins = c.branches.flatMap((b) => b.admins.map((a) => ({ ...a, branch: branchLabel(b) })));

  return (
    <section className={`bg-ink-card border border-ink-border rounded ${c.isActive ? "" : "opacity-75"}`}>
      {/* Header: name, status, rename, deactivate */}
      <div className="flex flex-wrap items-center gap-3 px-5 py-4 border-b border-ink-border">
        {renaming ? (
          <form
            className="flex flex-1 flex-wrap gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await act(`rename-${c.id}`, c.id, { action: "update", name }, `Renamed to ${name.trim()}`)) setRenaming(false);
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={100} aria-label="Company name" className={`${compactInput} flex-1 min-w-[12rem]`} />
            <button type="submit" className="act act-primary" disabled={busy !== null || !name.trim()}>Save</button>
            <button type="button" className="act" onClick={() => { setRenaming(false); setName(c.name); }}>Cancel</button>
          </form>
        ) : (
          <>
            <h2 className="font-mono text-base text-ink-black">{c.name}</h2>
            <StatusBadge tone={c.isActive ? "green" : "amber"}>{c.isActive ? "Active" : "Inactive"}</StatusBadge>
            <span className="text-xs font-mono text-ink-muted">
              {c.branches.length} branch{c.branches.length === 1 ? "" : "es"} · {c.companyAdmins.length} company admin
              {c.companyAdmins.length === 1 ? "" : "s"}
            </span>
            <span className="flex-1" />
            <button type="button" className="act" onClick={() => setRenaming(true)}>Rename</button>
            <button
              type="button"
              className={c.isActive ? "act act-danger" : "act act-green"}
              disabled={busy !== null}
              title={c.isActive ? "Its company admins will see no branch until reactivated. Branches keep working." : undefined}
              onClick={() =>
                act(
                  `active-${c.id}`,
                  c.id,
                  { action: "update", isActive: !c.isActive },
                  c.isActive ? `${c.name} deactivated — its company admins see no branch` : `${c.name} reactivated`
                )
              }
            >
              {c.isActive ? "Deactivate" : "Reactivate"}
            </button>
          </>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-0 md:divide-x divide-ink-border">
        {/* Branches */}
        <div className="px-5 py-4 space-y-3">
          <p className={sectionTitle}>Branches</p>
          {c.branches.length === 0 ? (
            <p className="text-sm font-mono text-ink-muted">No branches yet.</p>
          ) : (
            <ul className="space-y-2">
              {c.branches.map((b) => (
                <li key={b.tenantId} className="flex items-center gap-2 text-sm font-mono">
                  <span className="flex-1 min-w-0">
                    <span className="text-ink-black">{branchLabel(b)}</span>
                    <span className="block text-[11px] text-ink-muted truncate">{handles(b.admins)}</span>
                  </span>
                  <button
                    type="button"
                    className="act act-danger"
                    disabled={busy !== null}
                    onClick={() => act(`detach-${b.tenantId}`, c.id, { action: "detachBranch", tenantId: b.tenantId }, `${branchLabel(b)} detached`)}
                  >
                    Detach
                  </button>
                </li>
              ))}
            </ul>
          )}
          {unassigned.length > 0 && (
            <div className="flex items-center gap-2 pt-1">
              <select value={attach} onChange={(e) => setAttach(e.target.value)} className={`${compactInput} flex-1 min-w-0`} aria-label="Branch to attach">
                <option value="">Attach a branch…</option>
                {unassigned.map((b) => (
                  <option key={b.tenantId} value={b.tenantId}>
                    {branchLabel(b)} ({handles(b.admins)})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="act act-green"
                disabled={busy !== null || !attach}
                onClick={async () => {
                  const b = unassigned.find((x) => x.tenantId === attach);
                  if (await act(`attach-${c.id}`, c.id, { action: "attachBranch", tenantId: attach }, `${b ? branchLabel(b) : "Branch"} attached to ${c.name}`)) setAttach("");
                }}
              >
                Attach
              </button>
            </div>
          )}
        </div>

        {/* Company admins and their allocations */}
        <div className="px-5 py-4 space-y-4 border-t md:border-t-0 border-ink-border">
          <div className="flex items-center gap-2">
            <p className={`${sectionTitle} flex-1`}>Company admins</p>
            <button type="button" className="act" onClick={() => setShowAdminForm((v) => !v)}>
              {showAdminForm ? "Cancel" : "+ Company admin"}
            </button>
          </div>
          {showAdminForm && (
            <NewCompanyAdmin
              companyId={c.id}
              busy={busy}
              act={act}
              onDone={() => setShowAdminForm(false)}
            />
          )}
          {c.companyAdmins.length === 0 && !showAdminForm && (
            <p className="text-sm font-mono text-ink-muted">None yet.</p>
          )}
          {c.companyAdmins.map((ca) => (
            <Allocations key={`${ca.id}:${ca.allocatedAdminIds.join(",")}`} companyId={c.id} companyAdmin={ca} branchAdmins={branchAdmins} busy={busy} act={act} />
          ))}
          {c.companyAdmins.length > 0 && (
            <p className="text-[11px] font-mono text-ink-muted">
              Reset a company admin&apos;s password or username, or deactivate one, on the Users page.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

function Allocations({
  companyId,
  companyAdmin: ca,
  branchAdmins,
  busy,
  act,
}: {
  companyId: string;
  companyAdmin: CompanyAdmin;
  branchAdmins: (Person & { branch: string })[];
  busy: string | null;
  act: Act;
}) {
  // Remounted (keyed on the saved allocations) when they change, so this
  // starts from what the server holds.
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(ca.allocatedAdminIds));
  const changed =
    chosen.size !== ca.allocatedAdminIds.length || ca.allocatedAdminIds.some((id) => !chosen.has(id));

  return (
    <div className="border border-ink-border rounded p-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm font-mono">
        <span className="text-ink-black">{ca.name}</span>
        <span className="text-[11px] text-ink-muted">{ca.username ? `@${ca.username}` : ""} · {ca.email}</span>
        {!ca.active && <StatusBadge tone="amber">Deactivated</StatusBadge>}
      </div>
      {branchAdmins.length === 0 ? (
        <p className="text-[11px] font-mono text-ink-muted">Attach a branch first — its admins can then be allocated.</p>
      ) : (
        <fieldset className="space-y-1">
          <legend className="sr-only">Branch admins {ca.name} oversees</legend>
          {branchAdmins.map((a) => (
            <label key={a.id} className="flex items-center gap-2 text-sm font-mono text-ink-black">
              <input
                type="checkbox"
                checked={chosen.has(a.id)}
                onChange={(e) =>
                  setChosen((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(a.id);
                    else next.delete(a.id);
                    return next;
                  })
                }
              />
              <span>{a.branch}</span>
              <span className="text-[11px] text-ink-muted">{a.username ? `@${a.username}` : a.name}</span>
            </label>
          ))}
        </fieldset>
      )}
      {changed && (
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            className="act act-primary"
            disabled={busy !== null}
            onClick={() =>
              act(
                `alloc-${ca.id}`,
                companyId,
                { action: "setAllocations", companyAdminId: ca.id, adminIds: [...chosen] },
                `${ca.name} now oversees ${chosen.size} branch admin${chosen.size === 1 ? "" : "s"}`
              )
            }
          >
            Save allocations
          </button>
          <button type="button" className="act" onClick={() => setChosen(new Set(ca.allocatedAdminIds))}>Undo</button>
        </div>
      )}
    </div>
  );
}

function NewCompanyAdmin({
  companyId,
  busy,
  act,
  onDone,
}: {
  companyId: string;
  busy: string | null;
  act: Act;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [username, setUsername] = useState("");
  const [usernameStatus, setUsernameStatus] = useState<UsernameStatus>("empty");
  const [password, setPassword] = useState("");
  const passwordError = password ? validatePassword(password) : null;
  const ready = name.trim() && email.trim() && usernameStatus === "available" && password && !passwordError;

  return (
    <form
      className="border border-ink-border rounded p-3 space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (await act(`new-admin-${companyId}`, companyId, { action: "addCompanyAdmin", name, email, username, password }, `Company admin @${username.trim().toLowerCase()} created`)) onDone();
      }}
    >
      <div>
        <label className={label} htmlFor={`ca-name-${companyId}`}>Name</label>
        <input id={`ca-name-${companyId}`} value={name} onChange={(e) => setName(e.target.value)} required className={input} />
      </div>
      <div>
        <label className={label} htmlFor={`ca-email-${companyId}`}>Email</label>
        <input id={`ca-email-${companyId}`} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required className={input} />
      </div>
      <div>
        <label className={label} htmlFor={`ca-username-${companyId}`}>Username</label>
        <UsernameField id={`ca-username-${companyId}`} value={username} onChange={setUsername} onStatusChange={setUsernameStatus} required />
      </div>
      <div>
        <label className={label} htmlFor={`ca-password-${companyId}`}>Password</label>
        <input
          id={`ca-password-${companyId}`}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          required
          className={input}
        />
        <p className={`text-[11px] mt-1.5 ${passwordError ? "text-ink-red" : "text-ink-muted"}`}>{passwordError || PASSWORD_HINT}</p>
      </div>
      <button type="submit" className="act act-primary" disabled={busy !== null || !ready}>
        {busy === `new-admin-${companyId}` ? "Creating…" : "Create company admin"}
      </button>
    </form>
  );
}
