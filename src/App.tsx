import { onAuthStateChanged, type User } from "firebase/auth";
import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BeetsRun, FamilyInfo, Playlist, ServerStatus, Suggestion, Track, YoutubeInfo } from "../shared/types";
import { api } from "./api";
import { AiBadge, ArtistPic, Cover } from "./art";
import { AlbumCard, ArtistCard, groupAlbums, groupArtists, Hero, songCount } from "./browse";
import { buildIndex, searchTracks } from "./search";
import { CoverPick } from "./CoverPick";
import { EditDialog } from "./EditDialog";
import { FixVietnamese } from "./FixVietnamese";
import { auth, firebaseConfigured, signInWithGoogle, signOut } from "./firebase";
import { PlayerBar, PlayerProvider, usePlayer } from "./player";
import { RatingsProvider, Stars } from "./ratings";
import { useLibrary } from "./useLibrary";

type Tab = "library" | "foryou" | "playlists" | "tools" | "family";

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
      <RatingsProvider>
        <Shell user={user} family={family} reloadFamily={loadFamily} />
      </RatingsProvider>
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
  // Editing names, Organize and enrich need the home server; they are disabled (with the reason) while it is unreachable.
  const [home, setHome] = useState<ServerStatus | null>(null);
  const checkHome = useCallback(async () => {
    try {
      setHome(await api.serverStatus());
    } catch (e) {
      setHome({ configured: true, ok: false, error: e instanceof Error ? e.message : "Could not check the home server", busy: null });
    }
  }, []);
  useEffect(() => {
    void checkHome();
    const t = window.setInterval(() => void checkHome(), 60000);
    window.addEventListener("focus", checkHome);
    return () => {
      window.clearInterval(t);
      window.removeEventListener("focus", checkHome);
    };
  }, [checkHome]);
  // Adding and fixing songs is the owner's job, so only the owner gets the Library tools tab.
  const tabs: [Tab, string][] = [
    ["library", "Library"], ["foryou", "For you"], ["playlists", "Playlists"],
    ...(family.role === "owner" ? [["tools", "Library tools"] as [Tab, string]] : []),
    ["family", "Family"],
  ];
  // The search box sticks right under the header, so it needs to know how tall the header is.
  const shellRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const shell = shellRef.current, header = headerRef.current;
    if (!shell || !header) return;
    const set = () => shell.style.setProperty("--header-h", `${header.offsetHeight}px`);
    set();
    const ro = new ResizeObserver(set);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="shell" ref={shellRef}>
      <header ref={headerRef}>
        <h1><img className="logo" src="/icon-192.png" alt="" /> MyMusic <small>{family.name}</small></h1>
        <nav>
          {tabs.map(([k, label]) => (
            <button key={k} className={tab === k ? "active" : ""} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
      </header>
      <main>
        {tab === "library" && <Library tracks={[...lib.tracks.values()]} playlists={[...lib.playlists.values()]} uid={user.uid} refresh={lib.refresh} home={home} />}
        {tab === "foryou" && <ForYou lib={lib} />}
        {tab === "playlists" && <Playlists lib={lib} uid={user.uid} />}
        {tab === "tools" && family.role === "owner" && <LibraryTools refresh={lib.refresh} home={home} recheck={checkHome} tracks={[...lib.tracks.values()]} />}
        {tab === "family" && <Family family={family} uid={user.uid} reload={reloadFamily} />}
      </main>
      <PlayerBar />
    </div>
  );
}

function TrackRow({ t, queue, extra, number, hideArtist, select, note }: { t: Track; queue: Track[]; extra?: React.ReactNode; number?: number; hideArtist?: boolean; select?: { picked: boolean; toggle: () => void }; note?: string }) {
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
      <span className="grow">
        <strong>{t.title}{t.ai && <> <AiBadge /></>}</strong>
        <small>{[hideArtist ? "" : t.artist, number === undefined ? t.album : ""].filter(Boolean).join(" · ")}</small>
        {note && <small className="muted">{note}</small>}
      </span>
      {t.duration > 0 && <small className="dur">{mins}:{String(Math.floor(t.duration % 60)).padStart(2, "0")}</small>}
      {!select && <Stars trackId={t.id} title={t.title} />}
      {extra}
    </li>
  );
}

type View = "albums" | "artists" | "songs";

function Library({ tracks, playlists, uid, refresh, home }: { tracks: Track[]; playlists: Playlist[]; uid: string; refresh: () => Promise<void>; home: ServerStatus | null }) {
  const canEdit = home?.ok !== false;
  const editOff = home && !home.ok ? `Editing names is unavailable: ${home.error}` : "";
  const [q, setQ] = useState("");
  const [view, setView] = useState<View>("albums");
  const [open, setOpen] = useState<{ kind: "album" | "artist"; key: string } | null>(null);
  // The list unmounts while an album or artist is open, so remember where it was scrolled to and go back there.
  const listScroll = useRef(0);
  const openItem = (o: { kind: "album" | "artist"; key: string }) => {
    listScroll.current = window.scrollY;
    setOpen(o);
  };
  useLayoutEffect(() => {
    window.scrollTo(0, open ? 0 : listScroll.current);
  }, [open]);
  // Typing stays instant: the lists below follow a deferred copy of the text, and only the visible view is built.
  const dq = useDeferredValue(q);
  const index = useMemo(() => buildIndex(tracks), [tracks]);
  const byTitle = useMemo(() => [...tracks].sort((a, b) => a.title.localeCompare(b.title)), [tracks]);
  const filtered = useMemo(() => searchTracks(byTitle, index, dq), [byTitle, index, dq]);
  const songs = filtered;
  const albums = useMemo(() => (view === "albums" ? groupAlbums(filtered) : []), [filtered, view]);
  const artists = useMemo(() => (view === "artists" ? groupArtists(filtered) : []), [filtered, view]);
  const counts = useMemo(
    () => ({
      albums: new Set(filtered.map((t) => t.album).filter(Boolean)).size,
      artists: new Set(filtered.map((t) => t.artist).filter(Boolean)).size,
      songs: filtered.length,
    }),
    [filtered],
  );
  const recent = useMemo(() => [...albums].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 12), [albums]);
  // A long result list is shown in pages, so a broad search does not build thousands of rows at once.
  const PAGE = 100;
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [dq, view]);
  const more = (n: number) => n > shown && <p><button className="link" onClick={() => setShown((s) => s + PAGE)}>Show {Math.min(PAGE, n - shown)} more of {n - shown}</button></p>;
  const detailAlbum = useMemo(() => (open?.kind === "album" ? groupAlbums(tracks).find((a) => a.key === open.key) : undefined), [tracks, open]);
  const detailArtist = useMemo(() => (open?.kind === "artist" ? groupArtists(tracks).find((a) => a.name === open.key) : undefined), [tracks, open]);
  const mine = playlists.filter((p) => p.ownerUid === uid);
  const allAlbums = useMemo(() => groupAlbums(tracks), [tracks]);
  const allArtists = useMemo(() => groupArtists(tracks), [tracks]);
  const [editing, setEditing] = useState<{ kind: "song"; track: Track } | { kind: "album" | "artist"; name: string } | null>(null);
  // An album or artist that no longer exists (renamed, merged, or its songs moved away): leave its page.
  // Not while a rename is saving: the page's new name only appears in the list once the library has refreshed.
  const renaming = useRef(false);
  useEffect(() => {
    if (!renaming.current && open && tracks.length > 0 && !detailAlbum && !detailArtist) setOpen(null);
  }, [open, tracks.length, detailAlbum, detailArtist]);

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
        } else if (v === "edit") {
          setEditing({ kind: "song", track: t });
        } else if (v === "del" && confirm(`Delete "${t.title}" for the whole family?`)) {
          await api.deleteTrack(t.id);
          await refresh();
        }
      }}
    >
      <option value="">⋯</option>
      <option value="new">＋ New playlist…</option>
      {mine.map((p) => <option key={p.id} value={`pl:${p.id}`}>{p.trackIds.includes(t.id) ? "✓ In" : "Add to"} {p.name}</option>)}
      <option value="edit" disabled={!canEdit}>Edit details…</option>
      <option value="del">Delete song…</option>
    </select>
  );

  /** The edit dialog: one song's details, or an album/artist name (typing an existing name merges the two). */
  const dialog = (() => {
    if (!editing) return null;
    const close = () => setEditing(null);
    if (editing.kind === "song") {
      const t = editing.track;
      return (
        <EditDialog
          title="Edit song"
          onClose={close}
          fields={[
            { key: "title", label: "Title", value: t.title, required: true },
            { key: "artist", label: "Artist", value: t.artist, options: allArtists.map((a) => a.name) },
            { key: "album", label: "Album", value: t.album, options: allAlbums.map((a) => a.name) },
            { key: "trackNo", label: "Track number", value: t.trackNo ? String(t.trackNo) : "", numeric: true },
            { key: "ai", label: "Made by AI (shows a badge)", value: t.ai ? "1" : "", checkbox: true },
          ]}
          onSave={async (v) => {
            const r = await api.editTrack(t.id, { title: v.title, artist: v.artist, album: v.album, trackNo: Number(v.trackNo) || 0, ai: v.ai === "1" });
            await refresh();
            flash(`Updated "${v.title.trim()}"${r?.warning ? ` ${r.warning}` : ""}`);
          }}
        />
      );
    }
    const kind = editing.kind;
    const current = editing.name;
    const groups = (kind === "album" ? allAlbums.map((a) => ({ name: a.name, count: a.tracks.length })) : allArtists.map((a) => ({ name: a.name, count: a.tracks.length })));
    const nfc = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
    const count = groups.find((g) => g.name === current)?.count ?? 0;
    return (
      <EditDialog
        title={kind === "album" ? "Rename or merge album" : "Rename or merge artist"}
        onClose={close}
        fields={[{ key: "name", label: kind === "album" ? "Album name" : "Artist name", value: current, required: true, options: groups.filter((g) => g.name !== current).map((g) => g.name) }]}
        hint={(v) => {
          const to = nfc(v.name ?? "");
          const target = groups.find((g) => g.name !== current && nfc(g.name) === to);
          return target
            ? { text: `"${target.name}" already exists (${songCount(target.count)}). All ${songCount(count)} here move into it and "${current}" is removed.`, action: "Merge" }
            : { text: `Renames the ${kind} on all ${songCount(count)}.`, action: "Rename" };
        }}
        onSave={async (v) => {
          const to = nfc(v.name);
          const existing = groups.find((g) => g.name !== current && nfc(g.name) === to);
          renaming.current = true;
          let r;
          try {
            r = await api.renameGroup(kind, current, to);
            await refresh();
            // Stay on the page under its new name (or the one it merged into), so more edits can follow.
            if (open?.kind === kind && open.key === current) setOpen({ kind, key: existing?.name ?? to });
          } finally {
            renaming.current = false;
          }
          flash(`${existing ? `Merged into ${existing.name}` : `Renamed to ${to}`}${r?.warning ? ` ${r.warning}` : ""}`);
        }}
      />
    );
  })();

  if (detailAlbum || detailArtist) {
    const back = () => setOpen(null);
    const list = detailAlbum?.tracks ?? detailArtist!.tracks;
    return (
      <div className="wide">
        {detailAlbum ? (
          <Hero cover={<Cover track={detailAlbum.art} seed={detailAlbum.name} className="lg" />} title={detailAlbum.name} subtitle={detailAlbum.artist} tracks={list} onBack={back}
            actions={
              <>
                <button disabled={!canEdit} title={editOff} onClick={() => setEditing({ kind: "album", name: detailAlbum.name })}>✎ Rename / merge</button>
                <CoverPick
                  label={detailAlbum.art ? "🖼 Replace cover" : "🖼 Add cover"}
                  // An album that has only app uploads needs no home server; the server says so if it is needed.
                  disabled={!canEdit && detailAlbum.tracks.some((t) => t.source === "nas")}
                  title={editOff}
                  onPick={async (image) => {
                    const r = await api.setAlbumCover(detailAlbum.name, image);
                    await refresh();
                    flash(`Cover saved.${r.warning ? ` ${r.warning}` : ""}`);
                  }}
                />
              </>
            } />
        ) : (
          <Hero cover={<ArtistPic name={detailArtist!.name} className="lg" />} title={detailArtist!.name} subtitle="Artist" tracks={list} onBack={back}
            actions={<button disabled={!canEdit} title={editOff} onClick={() => setEditing({ kind: "artist", name: detailArtist!.name })}>✎ Rename / merge</button>} />
        )}
        {editOff && <p className="error" role="alert">{editOff}</p>}
        {dialog}
        {toastEl}
        {selectBar(list)}
        <p className="muted">{songCount(list.length)} {selectLink}</p>
        <ul>
          {list.map((t) => (
            <TrackRow key={t.id} t={t} queue={list} number={detailAlbum ? t.trackNo : undefined} hideArtist={!!detailAlbum && detailAlbum.artist !== "Various artists"}
              extra={selecting ? undefined : rowExtra(t)} select={rowSelect(t)} />
          ))}
        </ul>
      </div>
    );
  }

  const views: [View, string][] = [["albums", "Albums"], ["artists", "Artists"], ["songs", "Songs"]];
  const noMatch = `Nothing matches "${dq.trim()}". Words can be in any order, and accents and capitals do not matter.`;
  return (
    <div className="wide">
      {dialog}
      {toastEl}
      <div className="search-box" aria-busy={q !== dq}>
        <input
          className="search"
          placeholder="Search songs, artists, albums"
          enterKeyHint="search"
          autoComplete="off"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Escape" && setQ("")}
        />
        {q && <button className="clear" aria-label="Clear search" title="Clear search" onClick={() => setQ("")}>✕</button>}
      </div>
      <div className="seg" role="tablist">
        {views.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={view === k} className={view === k ? "active" : ""} onClick={() => setView(k)}>
            {label}{dq.trim() && <small> {counts[k]}</small>}
          </button>
        ))}
      </div>
      {tracks.some((t) => !t.hasArt && t.source === "r2") && (
        <p className="muted">
          Some songs have no cover. <button className="link" onClick={() => void findCovers()}>Find missing covers online</button> {artMsg}
        </p>
      )}
      {tracks.length === 0 ? (
        <p className="muted">No songs yet. Add music to your NAS, then run "Sync music from NAS" in the Library tools tab.</p>
      ) : view === "albums" ? (
        <>
          {!q && recent.length > 1 && (
            <section>
              <h3>Recently added</h3>
              <div className="strip">
                {recent.map((a) => <AlbumCard key={a.key} album={a} onOpen={() => openItem({ kind: "album", key: a.key })} />)}
              </div>
              <h3>All albums <small>{albums.length}</small></h3>
            </section>
          )}
          <div className="grid">
            {albums.slice(0, shown).map((a) => <AlbumCard key={a.key} album={a} onOpen={() => openItem({ kind: "album", key: a.key })} />)}
          </div>
          {more(albums.length)}
          {albums.length === 0 && <p className="muted">{noMatch}</p>}
        </>
      ) : view === "artists" ? (
        <>
          <div className="grid">
            {artists.slice(0, shown).map((a) => <ArtistCard key={a.name} artist={a} onOpen={() => openItem({ kind: "artist", key: a.name })} />)}
          </div>
          {more(artists.length)}
          {artists.length === 0 && <p className="muted">{noMatch}</p>}
        </>
      ) : (
        <>
          {selectBar(songs)}
          <p className="muted">{songCount(songs.length)} {selectLink}</p>
          <ul>
            {songs.slice(0, shown).map((t) => <TrackRow key={t.id} t={t} queue={songs} extra={selecting ? undefined : rowExtra(t)} select={rowSelect(t)} />)}
          </ul>
          {more(songs.length)}
          {songs.length === 0 && <p className="muted">{noMatch}</p>}
        </>
      )}
    </div>
  );
}

/** AI suggestions from your ratings: a playlist from the library plus artists you might like, optionally for a mood. */
const MOODS = ["Rainy evening", "Workout", "Focus", "Dinner with family", "Road trip"];
interface ForYouState { busy: boolean; error: string; result: Suggestion | null; prompt: string }
let forYouState: ForYouState = { busy: false, error: "", result: null, prompt: "" };
const forYouSubs = new Set<() => void>();
const setForYou = (patch: Partial<ForYouState>) => {
  forYouState = { ...forYouState, ...patch };
  forYouSubs.forEach((f) => f());
};
const watchForYou = (f: () => void) => {
  forYouSubs.add(f);
  return () => void forYouSubs.delete(f);
};

function ForYou({ lib }: { lib: ReturnType<typeof useLibrary> }) {
  const { busy, error, result, prompt: mood } = useSyncExternalStore(watchForYou, () => forYouState);
  const p = usePlayer();
  const [saved, setSaved] = useState("");
  useEffect(() => setSaved(""), [result]);

  const ask = async () => {
    setForYou({ busy: true, error: "" });
    try {
      setForYou({ result: await api.suggest(mood.trim()), busy: false });
    } catch (e) {
      setForYou({ error: e instanceof Error ? e.message : "Could not get suggestions", busy: false });
    }
  };

  const picks = (result?.tracks ?? [])
    .map((s) => ({ t: lib.tracks.get(s.id), why: s.why }))
    .filter((x): x is { t: Track; why: string } => !!x.t);
  const queue = picks.map((x) => x.t);

  const save = async () => {
    if (!result) return;
    try {
      await api.savePlaylist({ id: crypto.randomUUID(), name: result.title, shared: false, trackIds: queue.map((t) => t.id) });
      await lib.refresh();
      setSaved(`Saved as a playlist: ${result.title}`);
    } catch (e) {
      setSaved(e instanceof Error ? e.message : "Could not save the playlist");
    }
  };

  return (
    <>
      <h2>For you</h2>
      <p className="muted">Rate songs with the stars and an AI picks what to listen to next. Add a mood if you want.</p>
      <form className="suggest-form" onSubmit={(e) => { e.preventDefault(); void ask(); }}>
        <input placeholder="Mood or occasion (optional)" value={mood} maxLength={200} onChange={(e) => setForYou({ prompt: e.target.value })} />
        <button className="primary" type="submit" disabled={busy}>{busy ? "Thinking…" : "Suggest"}</button>
        {busy && <span className="spinner" aria-hidden="true" />}
      </form>
      <div className="seg">
        {MOODS.map((m) => <button key={m} onClick={() => setForYou({ prompt: m })}>{m}</button>)}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {result && (
        <>
          <h3>{result.title}</h3>
          <p className="suggest-intro">{result.intro}</p>
          <p>
            <button className="primary" onClick={() => p.play(queue, 0)}>▶ Play</button>{" "}
            <button onClick={() => void save()}>Save as playlist</button>{" "}
            <button className="link" onClick={() => void ask()} disabled={busy}>Try again</button>{" "}
            <small className="muted">{saved}</small>
          </p>
          <ul>
            {picks.map((x) => <TrackRow key={x.t.id} t={x.t} queue={queue} note={x.why} />)}
          </ul>
          {result.discover.length > 0 && (
            <section className="discover">
              <h3>To discover</h3>
              <ul>
                {result.discover.map((d) => (
                  <li key={`${d.artist}|${d.album}`}>
                    <strong>{d.artist}</strong>{d.album ? ` · ${d.album}` : ""}
                    <small>{d.why}</small>
                  </li>
                ))}
              </ul>
            </section>
          )}
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

/** Owner tools for the shared library: where songs come from (NAS, inbox, YouTube) and fixing their names. */
function LibraryTools({ refresh, home, recheck, tracks }: { refresh: () => Promise<void>; home: ServerStatus | null; recheck: () => Promise<void>; tracks: Track[] }) {
  const [fixOpen, setFixOpen] = useState(false);
  const [nasMsg, setNasMsg] = useState("");
  const syncNas = async (): Promise<boolean> => {
    let offset = 0;
    const ids: string[] = [];
    try {
      for (;;) {
        setNasMsg(`Syncing… ${offset} songs`);
        const r = await api.syncNas(offset);
        offset = r.next;
        ids.push(...r.ids);
        if (r.done) break;
      }
      const { removed, skippedRemoval } = await api.finishNasSync(ids);
      setNasMsg(
        `Done: ${offset} songs from the NAS${removed ? `, ${removed} removed` : ""}.` +
          (skippedRemoval ? ` Not removing ${skippedRemoval} songs: the NAS list looked incomplete.` : ""),
      );
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
      <h2>Library tools</h2>
      <Organize syncNas={syncNas} home={home} recheck={recheck} />
      <p>
        <button onClick={() => void syncNas()}>Sync music from NAS</button> <small className="muted">{nasMsg}</small>
      </p>
      <p>
        <button onClick={() => setFixOpen((o) => !o)} disabled={home !== null && !home.ok} title={home !== null && !home.ok ? home.error : undefined}>
          {fixOpen ? "Hide Vietnamese name fixer" : "Fix Vietnamese names…"}
        </button>
      </p>
      {fixOpen && <FixVietnamese tracks={tracks} refresh={refresh} />}
    </>
  );
}

/** Who is in the family, inviting people, and this person's own account. */
function Family({ family, uid, reload }: { family: FamilyInfo; uid: string; reload: () => Promise<void> }) {
  const [code, setCode] = useState("");
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
      <hr />
      <p><small className="muted">Version {__APP_VERSION__}</small></p>
      <button className="link" onClick={() => signOut()}>Sign out</button>{" "}
      <button className="link danger" onClick={async () => { if (confirm("Delete your account? You leave the family and your playlists are deleted.")) { await api.deleteAccount(); await auth.currentUser?.delete().catch(() => signOut()); } }}>Delete my account</button>
    </>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const when = (t: number) => new Date(t).toLocaleString();

/** The enrich job's steps, in the order the home server runs them (it reports "step k of n" through the progress fields). */
const ENRICH_STEPS = ["Fetching missing cover art", "Embedding covers into the files", "Looking up genres"];
const YOUTUBE_STEPS = ["Downloading the audio", "Adding it to the library"];

const isOpen = (r: BeetsRun) => r.status === "requested" || r.status === "running";

/**
 * Owner tool: Beets runs on the home server (Organize, enrich, YouTube links, and imports that start by themselves when
 * files land in the inbox). The page follows every open run, then scans Navidrome and syncs the library.
 */
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

let tracking = false;
let lastSyncAt = 0;

/**
 * Follows the open Beets runs until none is left (any number of YouTube songs, and one import or enrich), and scans
 * Navidrome and syncs the library after runs finish: at once when everything is done, at most once a minute while
 * more keep coming. It lives outside the component so it keeps going when you leave the Library tools tab, and the tab picks
 * it up again when you come back. `first` are runs the caller has just started, so one that ends before the first
 * look is still noticed.
 */
async function track(syncNas: () => Promise<boolean>, first: string[] = []) {
  if (tracking) return;
  tracking = true;
  const seen = new Set<string>(first);
  let pendingSync = false;
  let failed = "";
  let doneMsg = "";
  try {
    const deadline = Date.now() + 3 * 3600 * 1000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("Gave up waiting for the server.");
      const { runs } = await api.beetsRuns();
      const open = runs.filter(isOpen);
      open.forEach((r) => seen.add(r.id));
      for (const r of runs) {
        if (!seen.has(r.id) || isOpen(r)) continue;
        seen.delete(r.id);
        if (r.status === "done") pendingSync = true;
        else failed = r.kind === "youtube" ? `Could not add ${r.label ?? "a song"}. See the log below.` : "Beets failed. See the log below.";
      }
      const main = open.find((r) => r.kind !== "youtube") ?? null;
      const imp = open.find((r) => r.kind === "import");
      const enr = open.find((r) => r.kind === "enrich");
      const songs = open.filter((r) => r.kind === "youtube").length;
      setOrganize({
        runs, active: main, busy: main !== null,
        msg: [
          imp ? (imp.status === "requested" ? "Waiting for the server…" : "Beets is importing…") : "",
          enr ? (enr.status === "requested" ? "Enrich is waiting for the server…" : "Beets is adding art and genres…") : "",
          songs ? `${songs} YouTube song${songs > 1 ? "s" : ""} in progress…` : "",
        ].filter(Boolean).join(" ") || organizeState.msg,
      });
      if (pendingSync && (open.length === 0 || Date.now() - lastSyncAt > 60_000)) {
        pendingSync = false;
        setOrganize({ busy: true, msg: "Scanning Navidrome…" });
        await api.scanNas();
        await sleep(2000);
        for (let i = 0; i < 200 && (await api.nasScanning()).scanning; i++) await sleep(3000);
        setOrganize({ msg: "Syncing the library…" });
        doneMsg = (await syncNas()) ? "Done: Beets ran, Navidrome scanned and the library synced." : "Beets ran, but the library sync failed.";
        lastSyncAt = Date.now();
        setOrganize({ msg: doneMsg });
        continue;
      }
      if (open.length === 0 && !pendingSync) break;
      await sleep(3000);
    }
    if (failed) setOrganize({ msg: failed });
  } catch (e) {
    setOrganize({ msg: e instanceof Error ? e.message : "Failed" });
  } finally {
    tracking = false;
    setOrganize({ busy: false, active: null });
    await refreshRuns();
  }
}

/** One YouTube link in the "add songs" list: what the server read from it, and the names to use. */
interface YtRow {
  url: string;
  info: YoutubeInfo | null;
  error: string;
  title: string;
  artist: string;
  album: string;
  ai: boolean;
}

/** Why none of the looked-up links can be added yet, for the line under the form. */
function ytHint(rows: YtRow[]): string {
  const pending = rows.filter((r) => !r.info && !r.error).length;
  if (pending) return `${pending} link${pending === 1 ? " is" : "s are"} still being looked up.`;
  const tooLong = rows.filter((r) => r.info?.tooLong).length;
  const noArtist = rows.filter((r) => r.info && !r.info.tooLong && !r.artist.trim()).length;
  const noTitle = rows.filter((r) => r.info && !r.info.tooLong && !r.title.trim()).length;
  const failed = rows.filter((r) => r.error).length;
  const why = [
    noArtist ? `fill in the artist (${noArtist})` : "",
    noTitle ? `fill in the title (${noTitle})` : "",
    tooLong ? `${tooLong} too long (max 2 hours), remove ${tooLong === 1 ? "it" : "them"}` : "",
    failed ? `${failed} could not be read, remove ${failed === 1 ? "it" : "them"} or fix the link` : "",
  ].filter(Boolean);
  return why.length ? `Not ready: ${why.join("; ")}.` : "";
}

function Organize({ syncNas, home, recheck }: { syncNas: () => Promise<boolean>; home: ServerStatus | null; recheck: () => Promise<void> }) {
  const down = home !== null && !home.ok;
  const { busy, msg, runs } = useSyncExternalStore(watchOrganize, () => organizeState);
  // An import and an enrich may run at the same time (the server queues them for the library); each button only waits for its own kind.
  const imp = runs.find((r) => r.kind === "import" && isOpen(r)) ?? null;
  const enr = runs.find((r) => r.kind === "enrich" && isOpen(r)) ?? null;
  const scanning = busy && !imp && !enr;
  const sync = useRef(syncNas);
  sync.current = syncNas;

  // Follow whatever is running (also imports the server started by itself): once now, then while the tab is open.
  useEffect(() => {
    const look = async () => {
      await refreshRuns();
      if (organizeState.runs.some(isOpen)) void track(() => sync.current());
    };
    void look();
    const t = setInterval(() => void look(), 10_000);
    return () => clearInterval(t);
  }, []);

  const organize = async () => {
    try {
      const run = await api.runBeets();
      void track(() => sync.current(), [run.id]);
    } catch (e) {
      setOrganize({ msg: e instanceof Error ? e.message : "Failed" });
    }
  };

  const enrich = async () => {
    try {
      const run = await api.runEnrich();
      void track(() => sync.current(), [run.id]);
    } catch (e) {
      setOrganize({ msg: e instanceof Error ? e.message : "Failed" });
    }
  };

  // Add songs from YouTube links: paste one or more, look them up, confirm or edit the names, then the server
  // downloads a few at a time and imports each. More links can be added while others are still going.
  const [ytText, setYtText] = useState("");
  const [ytRows, setYtRows] = useState<YtRow[]>([]);
  const [ytBusy, setYtBusy] = useState(false);
  const [ytErr, setYtErr] = useState("");
  const patchRow = (url: string, patch: Partial<YtRow>) => setYtRows((rows) => rows.map((r) => (r.url === url ? { ...r, ...patch } : r)));
  const lookUp = async () => {
    const urls = [...new Set(ytText.split(/\s+/).filter(Boolean))].slice(0, 20);
    if (!urls.length) return;
    setYtBusy(true);
    setYtErr("");
    setYtRows(urls.map((url) => ({ url, info: null, error: "", title: "", artist: "", album: "", ai: false })));
    const queue = [...urls];
    const worker = async () => {
      for (let url = queue.shift(); url !== undefined; url = queue.shift()) {
        try {
          const info = await api.youtubeInfo(url);
          patchRow(url, { info, title: info.title, artist: info.artist, album: info.album, ai: info.aiLabel || info.aiHint });
        } catch (e) {
          patchRow(url, { error: e instanceof Error ? e.message : "Could not read that link" });
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    setYtBusy(false);
  };
  const usable = (r: YtRow) => r.info !== null && !r.info.tooLong && r.title.trim() !== "" && r.artist.trim() !== "";
  const addAll = async () => {
    setYtBusy(true);
    setYtErr("");
    const left: YtRow[] = [];
    const started: string[] = [];
    for (const r of ytRows) {
      if (!usable(r)) {
        left.push(r);
        continue;
      }
      try {
        const run = await api.importYoutube({ url: r.url, title: r.title, artist: r.artist, album: r.album, ai: r.ai });
        started.push(run.id);
      } catch (e) {
        left.push({ ...r, error: e instanceof Error ? e.message : "Failed" });
      }
    }
    setYtRows(left);
    if (!left.length) setYtText("");
    setYtBusy(false);
    if (started.length) {
      await refreshRuns();
      void track(() => sync.current(), started);
    }
  };

  const ytRuns = runs.filter((r) => r.kind === "youtube" && isOpen(r));

  return (
    <>
      <p>
        <button disabled={scanning || imp !== null || down} onClick={() => void organize()}>Organize inbox and update library</button>{" "}
        <button disabled={scanning || enr !== null || down} onClick={() => void enrich()} title="Fetch missing cover art and genres now, like the nightly job">Run enrich now</button>{" "}
        {busy && <span className="spinner" aria-hidden="true" />}
        <small className="muted" role="status">{msg}</small>
      </p>
      {home?.ok && (home.autoImport || (home.waiting ?? 0) > 0) && (
        <p>
          <small className="muted">
            {home.autoImport ? "Files added to the inbox are imported automatically." : ""}
            {(home.waiting ?? 0) > 0 ? ` ${home.waiting} file${home.waiting === 1 ? "" : "s"} waiting in the inbox.` : ""}
          </small>
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ytRows.length && !ytBusy) void addAll();
          else if (ytText.trim()) void lookUp();
        }}
      >
        <p>
          <strong>Add songs from YouTube</strong>
        </p>
        <p>
          <textarea
            value={ytText}
            rows={2}
            placeholder="Paste one or more YouTube links, one per line"
            aria-label="YouTube links"
            disabled={ytBusy || down}
            onChange={(e) => {
              setYtText(e.target.value);
              setYtRows([]);
            }}
          />{" "}
          {ytRows.length === 0 && <button type="submit" disabled={ytBusy || down || !ytText.trim()}>{ytBusy ? "Looking up…" : "Look up"}</button>}
        </p>
        {ytRows.map((r) => (
          <fieldset key={r.url}>
            <legend><small className="muted">{r.url}</small></legend>
            {r.error && <p className="error" role="alert">{r.error}</p>}
            {!r.info && !r.error && <p><small className="muted">Looking up…</small></p>}
            {r.info && (
              <>
                <p>
                  <label>Title <input value={r.title} onChange={(e) => patchRow(r.url, { title: e.target.value })} /></label>{" "}
                  <label>Artist <input value={r.artist} onChange={(e) => patchRow(r.url, { artist: e.target.value })} /></label>{" "}
                  <label>Album (optional) <input value={r.album} onChange={(e) => patchRow(r.url, { album: e.target.value })} /></label>
                </p>
                <p>
                  <label>
                    <input type="checkbox" checked={r.ai} onChange={(e) => patchRow(r.url, { ai: e.target.checked })} /> Made by AI (shows a badge)
                    {r.info.aiLabel
                      ? <small className="muted"> · YouTube labels this video as made with AI</small>
                      : r.info.aiHint && <small className="muted"> · the video's description mentions AI</small>}
                  </label>{" "}
                  <small className="muted">{Math.floor(r.info.duration / 60)}:{String(r.info.duration % 60).padStart(2, "0")}{r.info.tooLong ? " · too long for the server (max 2 hours)" : ""}</small>
                </p>
              </>
            )}
            <button type="button" className="link" onClick={() => setYtRows((rows) => rows.filter((x) => x.url !== r.url))}>Remove</button>
          </fieldset>
        ))}
        {ytRows.length > 0 && (
          <p>
            <button type="submit" disabled={ytBusy || down || !ytRows.some(usable)}>
              Add {ytRows.filter(usable).length > 1 ? `${ytRows.filter(usable).length} songs` : "to library"}
            </button>
          </p>
        )}
        {ytRows.length > 0 && !ytBusy && !ytRows.some(usable) && (
          <p><small className="muted">{ytHint(ytRows)}</small></p>
        )}
        {ytErr && <p className="error" role="alert">{ytErr}</p>}
      </form>
      {ytRuns.length > 0 && (
        <ul>
          {ytRuns.map((r) => {
            // The server reports before = number of steps and now = steps still to do.
            const total = YOUTUBE_STEPS.length;
            const done = Math.min(total, Math.max(0, (r.inboxBefore ?? total) - (r.inboxNow ?? total)));
            return (
              <li key={r.id}>
                {r.label ?? "YouTube song"}:{" "}
                {r.status === "requested"
                  ? <small className="muted">waiting for a free download slot</small>
                  : (
                    <>
                      <progress max={total} value={done} />{" "}
                      <small className="muted">
                        {r.inboxNow === null ? "starting…" : `step ${Math.min(total, done + 1)} of ${total}: ${YOUTUBE_STEPS[Math.min(total - 1, done)]}`}
                      </small>
                    </>
                  )}
              </li>
            );
          })}
        </ul>
      )}
      {down && (
        <p className="error" role="alert">
          Home server unavailable: {home.error} <button className="link" onClick={() => void recheck()}>Check again</button>
        </p>
      )}
      {enr?.status === "running" && (() => {
        // The server reports before = number of steps and now = steps still to do.
        const total = ENRICH_STEPS.length;
        const done = Math.min(total, Math.max(0, (enr.inboxBefore ?? total) - (enr.inboxNow ?? total)));
        return (
          <p>
            <progress max={total} value={done} />{" "}
            <small className="muted">
              {enr.inboxNow === null ? "Waiting for the server to start…" : `Step ${Math.min(total, done + 1)} of ${total}: ${ENRICH_STEPS[Math.min(total - 1, done)]}`}
            </small>
          </p>
        );
      })()}
      {imp?.status === "running" && imp.inboxBefore !== null && imp.inboxNow !== null && imp.inboxBefore > 0 && (
        <p>
          <progress max={imp.inboxBefore} value={Math.max(0, imp.inboxBefore - imp.inboxNow)} />{" "}
          <small className="muted">{Math.max(0, imp.inboxBefore - imp.inboxNow)} of {imp.inboxBefore} files imported</small>
        </p>
      )}
      {runs.length > 0 && (
        <details>
          <summary>Beets history</summary>
          <ul>
            {runs.map((r) => (
              <li key={r.id}>
                <strong>
                  {r.kind === "enrich" ? "Enrich (covers and genres)" : r.kind === "youtube" ? `YouTube import${r.label ? ` (${r.label})` : ""}` : "Import"}
                  : {r.status === "requested" ? "queued" : r.status}
                </strong>{" "}
                <small className="muted">{when(r.requestedAt)}</small>
                {r.kind === "import" && r.inboxBefore !== null && r.inboxAfter !== null && (
                  <small className="muted"> · {r.inboxBefore} file{r.inboxBefore === 1 ? "" : "s"}, {r.inboxAfter} not imported</small>
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
