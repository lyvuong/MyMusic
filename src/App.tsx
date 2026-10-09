import { onAuthStateChanged, type User } from "firebase/auth";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BeetsRun, FamilyInfo, Playlist, Track } from "../shared/types";
import { api } from "./api";
import { ArtistPic, Cover } from "./art";
import { AlbumCard, ArtistCard, groupAlbums, groupArtists, Hero, songCount } from "./browse";
import { auth, firebaseConfigured, signInWithGoogle, signOut } from "./firebase";
import { PlayerBar, PlayerProvider, usePlayer } from "./player";
import { useLibrary } from "./useLibrary";

type Tab = "library" | "playlists" | "family";

export function App() {
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = still loading
  const [family, setFamily] = useState<FamilyInfo | null | undefined>(undefined);
  const [error, setError] = useState("");

  useEffect(() => (firebaseConfigured ? onAuthStateChanged(auth, setUser) : undefined), []);

  const loadFamily = useCallback(async () => {
    try {
      setFamily(await api.family());
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  }, []);

  useEffect(() => {
    if (user) void loadFamily();
    else setFamily(undefined);
  }, [user, loadFamily]);

  if (!firebaseConfigured) return <Center>Firebase is not configured. Copy .env.example to .env.local and fill it in.</Center>;
  if (user === undefined) return <Center>Loading…</Center>;
  if (!user) return <SignIn />;
  if (error) return <Center>{error}</Center>;
  if (family === undefined) return <Center>Loading…</Center>;
  if (!family) return <FamilySetup onDone={setFamily} />;
  return (
    <PlayerProvider>
      <Shell user={user} family={family} reloadFamily={loadFamily} />
    </PlayerProvider>
  );
}

const Center = ({ children }: { children: React.ReactNode }) => <main className="center">{children}</main>;

function SignIn() {
  const [err, setErr] = useState("");
  return (
    <Center>
      <img className="logo big" src="/icon-192.png" alt="" />
      <h1>MyMusic</h1>
      <p className="muted">Your family&apos;s music, anywhere.</p>
      <button className="primary" onClick={() => signInWithGoogle().catch((e: Error) => setErr(e.message))}>Continue with Google</button>
      {err && <p className="error">{err}</p>}
    </Center>
  );
}

function FamilySetup({ onDone }: { onDone: (f: FamilyInfo) => void }) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const run = (p: Promise<FamilyInfo>) => p.then(onDone).catch((e: Error) => setErr(e.message));
  return (
    <Center>
      <h2>Your family</h2>
      <div className="card">
        <h3>Start a family</h3>
        <input placeholder="Family name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="primary" disabled={!name.trim()} onClick={() => run(api.createFamily(name.trim()))}>Create</button>
      </div>
      <div className="card">
        <h3>Join with an invite code</h3>
        <input placeholder="Code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <button disabled={!code.trim()} onClick={() => run(api.joinFamily(code))}>Join</button>
      </div>
      {err && <p className="error">{err}</p>}
      <button className="link" onClick={() => signOut()}>Sign out</button>
    </Center>
  );
}

function Shell({ user, family, reloadFamily }: { user: User; family: FamilyInfo; reloadFamily: () => Promise<void> }) {
  const [tab, setTab] = useState<Tab>("library");
  const lib = useLibrary(true);
  const tabs: [Tab, string][] = [["library", "Library"], ["playlists", "Playlists"], ["family", "Family"]];
  return (
    <div className="shell">
      <header>
        <h1><img className="logo" src="/icon-192.png" alt="" /> MyMusic <small>{family.name}</small></h1>
        <nav>
          {tabs.map(([k, label]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
      </header>
      <main>
        {tab === "library" && <Library tracks={[...lib.tracks.values()]} playlists={[...lib.playlists.values()]} uid={user.uid} refresh={lib.refresh} />}
        {tab === "playlists" && <Playlists lib={lib} uid={user.uid} />}
        {tab === "family" && <Family family={family} uid={user.uid} reload={reloadFamily} refresh={lib.refresh} />}
      </main>
      <PlayerBar />
    </div>
  );
}

function TrackRow({ t, queue, extra, number, hideArtist, select }: { t: Track; queue: Track[]; extra?: React.ReactNode; number?: number; hideArtist?: boolean; select?: { picked: boolean; toggle: () => void } }) {
  const p = usePlayer();
  const active = p.current?.id === t.id;
  const mins = Math.floor(t.duration / 60);
  return (
    <li className={`row${active ? " active" : ""}${select?.picked ? " picked" : ""}`} onClick={select?.toggle}>
      {select && <input className="pick" type="checkbox" checked={select.picked} onChange={select.toggle} onClick={(e) => e.stopPropagation()} aria-label={`Select ${t.title}`} />}
      <button className="lead" onClick={select ? undefined : () => p.play(queue, queue.findIndex((x) => x.id === t.id))} aria-label={`Play ${t.title}`}>
        {number === undefined ? <Cover track={t} seed={t.album || t.title} className="sm" /> : <span className="num">{number || "–"}</span>}
        <span className="badge">{active && p.playing ? "♪" : "▶"}</span>
      </button>
      <span className="grow"><strong>{t.title}</strong><small>{[hideArtist ? "" : t.artist, number === undefined ? t.album : ""].filter(Boolean).join(" · ")}</small></span>
      {t.duration > 0 && <small className="dur">{mins}:{String(Math.floor(t.duration % 60)).padStart(2, "0")}</small>}
      {extra}
    </li>
  );
}

type View = "albums" | "artists" | "songs";

function Library({ tracks, playlists, uid, refresh }: { tracks: Track[]; playlists: Playlist[]; uid: string; refresh: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("albums");
  const [open, setOpen] = useState<{ kind: "album" | "artist"; key: string } | null>(null);
  const filtered = useMemo(() => {
    const s = q.toLowerCase();
    return tracks.filter((t) => !s || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(s));
  }, [tracks, q]);
  const songs = useMemo(() => [...filtered].sort((a, b) => a.title.localeCompare(b.title)), [filtered]);
  const albums = useMemo(() => groupAlbums(filtered), [filtered]);
  const artists = useMemo(() => groupArtists(filtered), [filtered]);
  const recent = useMemo(() => [...albums].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12), [albums]);
  const detailAlbum = useMemo(() => (open?.kind === "album" ? groupAlbums(tracks).find((a) => a.key === open.key) : undefined), [tracks, open]);
  const detailArtist = useMemo(() => (open?.kind === "artist" ? groupArtists(tracks).find((a) => a.name === open.key) : undefined), [tracks, open]);
  const mine = playlists.filter((p) => p.ownerUid === uid);

  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const stopSelecting = () => {
    setSelecting(false);
    setPicked(new Set());
  };
  useEffect(stopSelecting, [view, open]);
  const toggle = (id: string) =>
    setPicked((old) => {
      const n = new Set(old);
      if (!n.delete(id)) n.add(id);
      return n;
    });

  const [toast, setToast] = useState("");
  const toastTimer = useRef<number>(0);
  const flash = (m: string) => {
    setToast(m);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 3000);
  };
  const toastEl = toast ? <div className={selecting ? "toast high" : "toast"} role="status">{toast}</div> : null;

  const what = (ts: Track[]) => (ts.length === 1 ? `"${ts[0]!.title}"` : `${ts.length} songs`);

  /** Adds songs to one of your playlists, skipping ones already in it. Returns whether anything was added. */
  const addMany = async (pl: Playlist, ts: Track[]): Promise<boolean> => {
    const fresh = ts.filter((t) => !pl.trackIds.includes(t.id));
    if (fresh.length === 0) {
      flash(ts.length === 1 ? `${what(ts)} is already in ${pl.name}` : `Already in ${pl.name}`);
      return false;
    }
    try {
      await api.savePlaylist({ ...pl, trackIds: [...pl.trackIds, ...fresh.map((t) => t.id)] });
      await refresh();
      flash(`Added ${what(fresh)} to ${pl.name}`);
      return true;
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not add to the playlist");
      return false;
    }
  };

  /** Asks for a name, then creates a playlist holding the songs. */
  const createWith = async (ts: Track[]): Promise<boolean> => {
    const name = prompt("Name for the new playlist")?.trim();
    if (!name) return false;
    try {
      await api.savePlaylist({ id: crypto.randomUUID(), name, shared: false, trackIds: ts.map((t) => t.id) });
      await refresh();
      flash(`Created ${name} with ${what(ts)}`);
      return true;
    } catch (e) {
      flash(e instanceof Error ? e.message : "Could not create the playlist");
      return false;
    }
  };

  /** Bar above the player while picking songs: how many, select all, add to a playlist, done. */
  const selectBar = (visible: Track[]) => {
    if (!selecting) return null;
    const chosen = visible.filter((t) => picked.has(t.id));
    return (
      <div className="selectbar" role="toolbar" aria-label="Selected songs">
        <strong>{chosen.length} selected</strong>
        <button className="link" onClick={() => setPicked(new Set(visible.map((t) => t.id)))}>All</button>
        <select
          value=""
          disabled={chosen.length === 0}
          aria-label="Add the selected songs to a playlist"
          onChange={async (e) => {
            const v = e.target.value;
            const pl = mine.find((p) => p.id === v);
            if (v === "new" ? await createWith(chosen) : pl ? await addMany(pl, chosen) : false) stopSelecting();
          }}
        >
          <option value="">Add to…</option>
          <option value="new">＋ New playlist…</option>
          {mine.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button onClick={stopSelecting}>Done</button>
      </div>
    );
  };
  const selectLink = !selecting && <button className="link" onClick={() => setSelecting(true)}>Select</button>;
  const rowSelect = (t: Track) => (selecting ? { picked: picked.has(t.id), toggle: () => toggle(t.id) } : undefined);

  const [artMsg, setArtMsg] = useState("");
  const findCovers = async () => {
    let found = 0;
    try {
      for (let left = 1; left > 0; ) {
        setArtMsg(`Looking up covers… ${found} found`);
        const r = await api.fetchArt();
        found += r.updated;
        left = r.remaining;
      }
      setArtMsg(`Done: ${found} new cover${found === 1 ? "" : "s"}.`);
    } catch (e) {
      setArtMsg(e instanceof Error ? e.message : "Cover lookup failed");
    }
    await refresh();
  };

  const rowExtra = (t: Track) => (
    <select
      className="more"
      value=""
      aria-label={`More actions for ${t.title}`}
      onChange={async (e) => {
        const v = e.target.value;
        if (v === "new") {
          await createWith([t]);
        } else if (v.startsWith("pl:")) {
          const pl = mine.find((p) => p.id === v.slice(3));
          if (pl) await addMany(pl, [t]);
        } else if (v === "del" && confirm(`Delete "${t.title}" for the whole family?`)) {
          await api.deleteTrack(t.id);
          await refresh();
        }
      }}
    >
      <option value="">⋯</option>
      <option value="new">＋ New playlist…</option>
      {mine.map((p) => <option key={p.id} value={`pl:${p.id}`}>{p.trackIds.includes(t.id) ? "✓ In" : "Add to"} {p.name}</option>)}
      <option value="del">Delete song…</option>
    </select>
  );

  if (detailAlbum || detailArtist) {
    const back = () => setOpen(null);
    const list = detailAlbum?.tracks ?? detailArtist!.tracks;
    return (
      <>
        {detailAlbum ? (
          <Hero cover={<Cover track={detailAlbum.art} seed={detailAlbum.name} className="lg" />} title={detailAlbum.name} subtitle={detailAlbum.artist} tracks={list} onBack={back} />
        ) : (
          <Hero cover={<ArtistPic name={detailArtist!.name} className="lg" />} title={detailArtist!.name} subtitle="Artist" tracks={list} onBack={back} />
        )}
        {toastEl}
        {selectBar(list)}
        <p className="muted">{songCount(list.length)} {selectLink}</p>
        <ul>
          {list.map((t) => (
            <TrackRow key={t.id} t={t} queue={list} number={detailAlbum ? t.trackNo : undefined} hideArtist={!!detailAlbum && detailAlbum.artist !== "Various artists"}
              extra={selecting ? undefined : rowExtra(t)} select={rowSelect(t)} />
          ))}
        </ul>
      </>
    );
  }

  const views: [View, string][] = [["albums", "Albums"], ["artists", "Artists"], ["songs", "Songs"]];
  return (
    <>
      {toastEl}
      <input className="search" placeholder="Search your music" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="seg" role="tablist">
        {views.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={view === k} className={view === k ? "active" : ""} onClick={() => setView(k)}>{label}</button>
        ))}
      </div>
      {tracks.some((t) => !t.hasArt && t.source === "r2") && (
        <p className="muted">
          Some songs have no cover. <button className="link" onClick={() => void findCovers()}>Find missing covers online</button> {artMsg}
        </p>
      )}
      {tracks.length === 0 ? (
        <p className="muted">No songs yet. Add music to your NAS, then run "Sync music from NAS" in the Family tab.</p>
      ) : view === "albums" ? (
        <>
          {!q && recent.length > 1 && (
            <section>
              <h3>Recently added</h3>
              <div className="strip">
                {recent.map((a) => <AlbumCard key={a.key} album={a} onOpen={() => setOpen({ kind: "album", key: a.key })} />)}
              </div>
              <h3>All albums <small>{albums.length}</small></h3>
            </section>
          )}
          <div className="grid">
            {albums.map((a) => <AlbumCard key={a.key} album={a} onOpen={() => setOpen({ kind: "album", key: a.key })} />)}
          </div>
          {albums.length === 0 && <p className="muted">No albums match.</p>}
        </>
      ) : view === "artists" ? (
        <>
          <div className="grid">
            {artists.map((a) => <ArtistCard key={a.name} artist={a} onOpen={() => setOpen({ kind: "artist", key: a.name })} />)}
          </div>
          {artists.length === 0 && <p className="muted">No artists match.</p>}
        </>
      ) : (
        <>
          {selectBar(songs)}
          <p className="muted">{songCount(songs.length)} {selectLink}</p>
          <ul>
            {songs.map((t) => <TrackRow key={t.id} t={t} queue={songs} extra={selecting ? undefined : rowExtra(t)} select={rowSelect(t)} />)}
          </ul>
        </>
      )}
    </>
  );
}

function Playlists({ lib, uid }: { lib: ReturnType<typeof useLibrary>; uid: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
  const open = openId ? lib.playlists.get(openId) : undefined;

  const create = async () => {
    const name = prompt("Playlist name")?.trim();
    if (!name) return;
    await api.savePlaylist({ id: crypto.randomUUID(), name, shared: false, trackIds: [] });
    await lib.refresh();
  };

  if (open) {
    const mine = open.ownerUid === uid;
    const tracks = open.trackIds.map((id) => lib.tracks.get(id)).filter((t): t is Track => !!t);
    const save = async (patch: Partial<Playlist>) => { await api.savePlaylist({ ...open, ...patch }); await lib.refresh(); };
    return (
      <>
        <button className="link" onClick={() => setOpenId(null)}>← All playlists</button>
        <h2>{open.name}</h2>
        {mine && (
          <p>
            <label><input type="checkbox" checked={open.shared} onChange={(e) => void save({ shared: e.target.checked })} /> Share with family</label>{" "}
            <button className="link danger" onClick={async () => { if (confirm("Delete this playlist?")) { await api.deletePlaylist(open.id); setOpenId(null); await lib.refresh(); } }}>Delete playlist</button>
          </p>
        )}
        <ul>
          {tracks.map((t) => (
            <TrackRow key={t.id} t={t} queue={tracks} extra={mine ? <button className="link" onClick={() => void save({ trackIds: open.trackIds.filter((x) => x !== t.id) })}>Remove</button> : undefined} />
          ))}
        </ul>
        {tracks.length === 0 && <p className="muted">Empty. Add songs from the Library tab.</p>}
      </>
    );
  }

  return (
    <>
      <button className="primary" onClick={create}>New playlist</button>
      <ul>
        {pls.map((p) => (
          <li key={p.id} className="row">
            <Cover track={p.trackIds.map((id) => lib.tracks.get(id)).find((t) => t?.hasArt)} seed={p.name} className="sm" />
            <button className="grow left" onClick={() => setOpenId(p.id)}>
              <strong>{p.name}</strong><small>{p.trackIds.length} songs{p.shared ? " · shared" : ""}{p.ownerUid === uid ? "" : " · from a family member"}</small>
            </button>
          </li>
        ))}
      </ul>
      {pls.length === 0 && <p className="muted">No playlists yet.</p>}
    </>
  );
}

function Family({ family, uid, reload, refresh }: { family: FamilyInfo; uid: string; reload: () => Promise<void>; refresh: () => Promise<void> }) {
  const [code, setCode] = useState("");
  const [nasMsg, setNasMsg] = useState("");
  const syncNas = async (): Promise<boolean> => {
    const run = Date.now();
    let offset = 0;
    let removed = 0;
    try {
      for (;;) {
        setNasMsg(`Syncing… ${offset} songs`);
        const r = await api.syncNas(offset, run);
        offset = r.next;
        removed += r.removed;
        if (r.done) break;
      }
      setNasMsg(`Done: ${offset} songs from the NAS${removed ? `, ${removed} removed` : ""}.`);
      return true;
    } catch (e) {
      setNasMsg(e instanceof Error ? e.message : "Sync failed");
      return false;
    } finally {
      await refresh();
    }
  };
  return (
    <>
      <h2>{family.name}</h2>
      <ul>
        {family.members.map((m) => (
          <li key={m.uid} className="row">
            <span className="grow"><strong>{m.displayName || m.email}</strong><small>{m.role}</small></span>
            {family.role === "owner" && m.uid !== uid && (
              <button className="link danger" onClick={async () => { if (confirm("Remove this member?")) { await api.removeMember(m.uid); await reload(); } }}>Remove</button>
            )}
          </li>
        ))}
      </ul>
      {family.role === "owner" && (
        <p>
          <button onClick={async () => setCode((await api.invite()).code)}>Create invite code</button>{" "}
          {code && <code className="code">{code}</code>}
        </p>
      )}
      {family.role === "owner" && <Organize syncNas={syncNas} />}
      {family.role === "owner" && (
        <p>
          <button onClick={() => void syncNas()}>Sync music from NAS</button> <small className="muted">{nasMsg}</small>
        </p>
      )}
      <hr />
      <button className="link" onClick={() => signOut()}>Sign out</button>{" "}
      <button className="link danger" onClick={async () => { if (confirm("Delete your account? You leave the family and your playlists are deleted.")) { await api.deleteAccount(); await auth.currentUser?.delete().catch(() => signOut()); } }}>Delete my account</button>
    </>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const when = (t: number) => new Date(t).toLocaleString();

/** Owner tool: run Beets on the home server, then scan Navidrome and sync the library, showing the result. */
interface OrganizeState { busy: boolean; msg: string; runs: BeetsRun[]; active: BeetsRun | null }
let organizeState: OrganizeState = { busy: false, msg: "", runs: [], active: null };
const organizeSubs = new Set<() => void>();
const setOrganize = (patch: Partial<OrganizeState>) => {
  organizeState = { ...organizeState, ...patch };
  organizeSubs.forEach((f) => f());
};
const watchOrganize = (f: () => void) => {
  organizeSubs.add(f);
  return () => void organizeSubs.delete(f);
};

async function refreshRuns() {
  try {
    setOrganize({ runs: (await api.beetsRuns()).runs });
  } catch {
    /* shown on the next action */
  }
}

/**
 * Follows a Beets run to the end, then scans Navidrome and syncs the library. It lives outside the component so it keeps
 * going when you leave the Family tab, and the tab picks it up again when you come back.
 */
async function followRun(first: BeetsRun, syncNas: () => Promise<boolean>) {
  if (organizeState.busy) return;
  setOrganize({ busy: true });
  try {
    let run = first;
    const deadline = Date.now() + 40 * 60 * 1000;
    while (run.status === "requested" || run.status === "running") {
      if (Date.now() > deadline) throw new Error("Gave up waiting for the server. Check the Unraid script.");
      setOrganize({ msg: run.status === "requested" ? "Waiting for the server to pick it up (up to a minute)…" : "Beets is importing…", active: run });
      await sleep(3000);
      const { runs: latest } = await api.beetsRuns();
      setOrganize({ runs: latest });
      const next = latest.find((r) => r.id === run.id);
      if (!next) throw new Error("The run disappeared from the history.");
      run = next;
      setOrganize({ active: run });
    }
    setOrganize({ active: null });
    if (run.status === "failed") throw new Error("Beets failed. See the log below.");
    setOrganize({ msg: "Scanning Navidrome…" });
    await api.scanNas();
    await sleep(2000);
    for (let i = 0; i < 200 && (await api.nasScanning()).scanning; i++) await sleep(3000);
    setOrganize({ msg: "Syncing the library…" });
    setOrganize({ msg: (await syncNas()) ? "Done: Beets ran, Navidrome scanned and the library synced." : "Beets ran, but the library sync failed." });
  } catch (e) {
    setOrganize({ msg: e instanceof Error ? e.message : "Failed" });
  } finally {
    setOrganize({ busy: false, active: null });
    await refreshRuns();
  }
}

function Organize({ syncNas }: { syncNas: () => Promise<boolean> }) {
  const { busy, msg, runs, active } = useSyncExternalStore(watchOrganize, () => organizeState);
  const sync = useRef(syncNas);
  sync.current = syncNas;

  // Coming back to the tab while a run is still going: show it and keep following it.
  useEffect(() => {
    void (async () => {
      await refreshRuns();
      const open = organizeState.runs.find((r) => r.status === "requested" || r.status === "running");
      if (open) void followRun(open, () => sync.current());
    })();
  }, []);

  const organize = async () => {
    try {
      await followRun(await api.runBeets(), () => sync.current());
    } catch (e) {
      setOrganize({ msg: e instanceof Error ? e.message : "Failed" });
    }
  };

  return (
    <>
      <p>
        <button disabled={busy} onClick={() => void organize()}>Organize inbox and update library</button>{" "}
        {busy && <span className="spinner" aria-hidden="true" />}
        <small className="muted" role="status">{msg}</small>
      </p>
      {active?.status === "running" && active.inboxBefore !== null && active.inboxNow !== null && active.inboxBefore > 0 && (
        <p>
          <progress max={active.inboxBefore} value={Math.max(0, active.inboxBefore - active.inboxNow)} />{" "}
          <small className="muted">{Math.max(0, active.inboxBefore - active.inboxNow)} of {active.inboxBefore} files imported</small>
        </p>
      )}
      {runs.length > 0 && (
        <details>
          <summary>Beets history</summary>
          <ul>
            {runs.map((r) => (
              <li key={r.id}>
                <strong>{r.status}</strong> <small className="muted">{when(r.requestedAt)}</small>
                {r.inboxBefore !== null && r.inboxAfter !== null && (
                  <small className="muted"> · inbox {r.inboxBefore} → {r.inboxAfter} files</small>
                )}
                {r.log && (
                  <details>
                    <summary>Log</summary>
                    <pre className="log">{r.log}</pre>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
