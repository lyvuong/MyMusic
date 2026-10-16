import { onAuthStateChanged, type User } from "firebase/auth";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { BeetsRun, FamilyInfo, Playlist, ServerStatus, Suggestion, TasteProfile, Track, YoutubeInfo } from "../shared/types";
import { api } from "./api";
import { AiBadge, ArtistPic, Cover } from "./art";
import { AlbumCard, ArtistCard, groupAlbums, groupArtists, Hero, songCount } from "./browse";
import { CoverPick } from "./CoverPick";
import { EditDialog } from "./EditDialog";
import { FixVietnamese } from "./FixVietnamese";
import { MissingAlbums } from "./MissingAlbums";
import { Home, useHome, type Jump } from "./Home";
import { auth, firebaseConfigured, signInWithGoogle, signOut } from "./firebase";
import { PlayerBar, PlayerProvider, usePlayer } from "./player";
import { RatingsProvider } from "./ratings";
import { TrackRow } from "./TrackRow";
import { useLibrary, type Library as LibraryState } from "./useLibrary";

type Tab = "home" | "library" | "foryou" | "playlists" | "tools" | "family";

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

// A YouTube link handed over by the "Add to MyMusic" bookmark (?yt=…): read once, then taken out of the address.
const incomingYoutube: string | null = (() => {
  try {
    const url = new URLSearchParams(location.search).get("yt");
    if (url) history.replaceState(null, "", location.pathname + location.hash);
    return url && url.length <= 300 ? url : null;
  } catch {
    return null;
  }
})();

function Shell({ user, family, reloadFamily }: { user: User; family: FamilyInfo; reloadFamily: () => Promise<void> }) {
  // Adding songs is the owner's job, so a link from the bookmark opens the Library tools tab.
  const [tab, setTab] = useState<Tab>(incomingYoutube && family.role === "owner" ? "tools" : "home");
  const lib = useLibrary(true);
  // The start page sends the Library tab to a search, a genre or one album.
  const [jump, setJump] = useState<Jump | null>(null);
  const goLibrary = (j: Omit<Jump, "n">) => {
    setJump({ ...j, n: Date.now() });
    setTab("library");
  };
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
    ["home", "Home"], ["library", "Library"], ["foryou", "For you"], ["playlists", "Playlists"],
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
        <nav aria-label="Sections">
          {tabs.map(([k, label]) => (
            <button key={k} className={tab === k ? "active" : ""} aria-current={tab === k ? "page" : undefined} onClick={() => setTab(k)}>{label}</button>
          ))}
        </nav>
      </header>
      <main>
        {tab === "home" && <Home lib={lib} isOwner={family.role === "owner"} go={goLibrary} />}
        {tab === "library" && <Library lib={lib} uid={user.uid} home={home} isOwner={family.role === "owner"} openTools={() => setTab("tools")} jump={jump} />}
        {tab === "foryou" && <ForYou lib={lib} />}
        {tab === "playlists" && <Playlists lib={lib} uid={user.uid} />}
        {tab === "tools" && family.role === "owner" && <LibraryTools lib={lib} home={home} recheck={checkHome} />}
        {tab === "family" && <Family family={family} uid={user.uid} reload={reloadFamily} />}
      </main>
      <PlayerBar />
    </div>
  );
}

type View = "albums" | "artists" | "songs";

function Library({ lib, uid, home, isOwner, openTools, jump }: { lib: LibraryState; uid: string; home: ServerStatus | null; isOwner: boolean; openTools: () => void; jump: Jump | null }) {
  const { refresh } = lib;
  const playlists = useMemo(() => [...lib.playlists.values()], [lib.playlists]);
  const canEdit = home?.ok !== false;
  const editOff = home && !home.ok ? `Editing names is unavailable: ${home.error}` : "";
  const [q, setQ] = useState("");
  const [genre, setGenre] = useState("");
  const [view, setView] = useState<View>("albums");
  const [open, setOpen] = useState<{ kind: "album" | "artist"; key: string } | null>(null);
  // Sent here from the start page: a search, a genre, or an album to open.
  useEffect(() => {
    if (!jump) return;
    setQ(jump.q ?? "");
    setGenre(jump.genre ?? "");
    setOpen(jump.open ?? null);
    if (jump.q || jump.genre) setView("songs");
  }, [jump]);
  // The list unmounts while an album or artist is open, so remember where it was scrolled to and go back there.
  const listScroll = useRef(0);
  const openItem = (o: { kind: "album" | "artist"; key: string }) => {
    listScroll.current = window.scrollY;
    setOpen(o);
  };
  useLayoutEffect(() => {
    window.scrollTo(0, open ? 0 : listScroll.current);
  }, [open]);

  // The server finds the songs: the text is sent a moment after typing stops, and only a page of results comes back.
  const [dq, setDq] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDq(q), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data: homeData } = useHome();
  const genres = homeData?.genres ?? [];
  const [results, setResults] = useState<Track[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const request = useRef(0);
  const { remember, version } = lib;
  const load = useCallback(async (cursor: number | undefined, reset: boolean) => {
    const id = ++request.current;
    setLoading(true);
    setLoadError("");
    try {
      const page = await api.browse({ q: dq.trim(), genre, cursor, view });
      if (id !== request.current) return;
      remember(page.tracks);
      setResults((old) => (reset ? page.tracks : [...old, ...page.tracks]));
      setNext(page.next);
    } catch (e) {
      if (id === request.current) setLoadError(e instanceof Error ? e.message : "Could not load");
    } finally {
      if (id === request.current) setLoading(false);
    }
  }, [dq, genre, view, remember]);
  // `version` changes when songs were edited, so the list is read again.
  useEffect(() => {
    void load(undefined, true);
  }, [load, version]);

  const songs = results;
  const albums = useMemo(() => (view === "albums" ? groupAlbums(results, true) : []), [results, view]);
  const artists = useMemo(() => (view === "artists" ? groupArtists(results, true) : []), [results, view]);
  const more = next !== null && (
    <p><button className="link" disabled={loading} onClick={() => void load(next, false)}>{loading ? "Loading…" : "Show more"}</button></p>
  );

  // One album or artist: all of its songs, asked for when it is opened.
  const [detail, setDetail] = useState<{ kind: "album" | "artist"; key: string; tracks: Track[] } | null>(null);
  const renaming = useRef(false);
  useEffect(() => {
    if (!open) return;
    let live = true;
    api.group(open.kind, open.key).then((r) => {
      if (!live) return;
      remember(r.tracks);
      // Gone (renamed, merged, or its songs moved away): leave its page. Not while a rename is saving.
      if (r.tracks.length === 0 && !renaming.current) setOpen(null);
      else setDetail({ ...open, tracks: r.tracks });
    }).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [open, version, remember]);
  const shownDetail = open && detail && detail.kind === open.kind && detail.key === open.key ? detail.tracks : null;
  const detailAlbum = useMemo(() => (open?.kind === "album" && shownDetail ? groupAlbums(shownDetail)[0] : undefined), [open, shownDetail]);
  const detailArtist = useMemo(() => (open?.kind === "artist" && shownDetail ? groupArtists(shownDetail)[0] : undefined), [open, shownDetail]);
  const mine = playlists.filter((p) => p.ownerUid === uid);
  const [editing, setEditing] = useState<{ kind: "song"; track: Track } | { kind: "album" | "artist"; name: string } | null>(null);
  const names = (kind: "album" | "artist") => async (typed: string) => (await api.names(kind, typed)).names;
  // Names the rename dialog last got from the server, so its hint can say "already exists" while you type.
  const knownNames = useRef<string[]>([]);

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

  /** Asks for a name in a dialog, then creates a playlist holding the songs. Resolves to whether it was created. */
  const [naming, setNaming] = useState<{ ts: Track[]; done: (ok: boolean) => void } | null>(null);
  const createWith = (ts: Track[]) => new Promise<boolean>((done) => setNaming({ ts, done }));

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
    if (naming) {
      const { ts, done } = naming;
      return (
        <EditDialog
          title="New playlist"
          onClose={() => { done(false); setNaming(null); }}
          fields={[{ key: "name", label: "Playlist name", value: "", required: true }]}
          hint={() => ({ text: `Starts with ${what(ts)}. Only you can see it until you share it.`, action: "Create" })}
          onSave={async (v) => {
            const name = v.name.trim();
            await api.savePlaylist({ id: crypto.randomUUID(), name, shared: false, trackIds: ts.map((t) => t.id) });
            await refresh();
            flash(`Created ${name} with ${what(ts)}`);
            done(true);
          }}
        />
      );
    }
    if (!editing) return null;
    const close = () => setEditing(null);
    if (editing.kind === "song") {
      const t = editing.track;
      return (
        <EditDialog
          title="Edit song"
          onClose={close}
          fields={[
            { key: "title", label: "Title", value: t.title, required: true, accents: isOwner },
            { key: "artist", label: "Artist", value: t.artist, lookup: names("artist"), accents: isOwner },
            { key: "album", label: "Album", value: t.album, lookup: names("album"), accents: isOwner },
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
    const nfc = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
    const count = shownDetail?.length ?? 0;
    return (
      <EditDialog
        title={kind === "album" ? "Rename or merge album" : "Rename or merge artist"}
        onClose={close}
        fields={[{ key: "name", label: kind === "album" ? "Album name" : "Artist name", value: current, required: true, accents: isOwner, kind, lookup: async (typed: string) => (knownNames.current = await names(kind)(typed)) }]}
        hint={(v) => {
          const to = nfc(v.name ?? "");
          const target = knownNames.current.find((n) => n !== current && nfc(n) === to);
          return target
            ? { text: `"${target}" already exists. All ${songCount(count)} here move into it and "${current}" is removed.`, action: "Merge" }
            : { text: `Renames the ${kind} on all ${songCount(count)}.`, action: "Rename" };
        }}
        onSave={async (v) => {
          const to = nfc(v.name);
          const existing = (await api.names(kind, to)).names.find((n) => n !== current && nfc(n) === to);
          renaming.current = true;
          let r;
          try {
            r = await api.renameGroup(kind, current, to);
            await refresh();
            // Stay on the page under its new name (or the one it merged into), so more edits can follow.
            if (open?.kind === kind && open.key === current) setOpen({ kind, key: existing ?? to });
          } finally {
            renaming.current = false;
          }
          flash(`${existing ? `Merged into ${existing}` : `Renamed to ${to}`}${r?.warning ? ` ${r.warning}` : ""}`);
        }}
      />
    );
  })();

  if (open && !detailAlbum && !detailArtist) {
    return <div className="wide"><p className="muted" role="status">Loading…</p></div>;
  }
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
  const filtered = !!dq.trim() || !!genre;
  const noMatch = filtered ? `Nothing matches${dq.trim() ? ` "${dq.trim()}"` : ""}${genre ? ` in ${genre}` : ""}. Words can be in any order, and accents and capitals do not matter.` : "";
  const heading = filtered ? "Results" : "Recently added";
  return (
    <div className="wide">
      {dialog}
      {toastEl}
      <div className="search-box" aria-busy={q !== dq || loading}>
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
      <div className="filters">
        <div className="seg" role="tablist">
          {views.map(([k, label]) => (
            <button key={k} role="tab" aria-selected={view === k} className={view === k ? "active" : ""} onClick={() => setView(k)}>{label}</button>
          ))}
        </div>
        {genres.length > 0 && (
          <select aria-label="Genre" value={genre} onChange={(e) => setGenre(e.target.value)}>
            <option value="">All genres</option>
            {genres.map((g) => <option key={g.name} value={g.name}>{g.name} ({g.count})</option>)}
          </select>
        )}
      </div>
      {loadError && <p className="error" role="alert">{loadError} <button className="link" onClick={() => void load(undefined, true)}>Try again</button></p>}
      {results.length === 0 && !loading && !loadError && !filtered ? (
        <div className="empty">
          <p><strong>No songs yet</strong></p>
          {isOwner
            ? <><p className="muted">Add songs from YouTube, or drop files into the NAS inbox and import them.</p><button className="primary" onClick={openTools}>Add music</button></>
            : <p className="muted">The family owner adds the music. Check back soon.</p>}
        </div>
      ) : view === "albums" ? (
        <>
          {albums.length > 0 && <h3>{heading}</h3>}
          <div className="grid">
            {albums.map((a) => <AlbumCard key={a.key} album={a} onOpen={() => openItem({ kind: "album", key: a.key })} />)}
          </div>
          {more}
          {albums.length === 0 && !loading && !loadError && <p className="muted">{noMatch || "No albums here."}</p>}
        </>
      ) : view === "artists" ? (
        <>
          {artists.length > 0 && <h3>{heading}</h3>}
          <div className="grid">
            {artists.map((a) => <ArtistCard key={a.name} artist={a} onOpen={() => openItem({ kind: "artist", key: a.name })} />)}
          </div>
          {more}
          {artists.length === 0 && !loading && !loadError && <p className="muted">{noMatch || "No artists here."}</p>}
        </>
      ) : (
        <>
          {selectBar(songs)}
          <h3>{heading}</h3>
          {songs.length > 0 && <p className="muted">{songs.length}{next !== null ? "+" : ""} songs {selectLink}</p>}
          <ul>
            {songs.map((t) => <TrackRow key={t.id} t={t} queue={songs} extra={selecting ? undefined : rowExtra(t)} select={rowSelect(t)} />)}
          </ul>
          {more}
          {songs.length === 0 && !loading && !loadError && <p className="muted">{noMatch || "No songs here."}</p>}
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

function ForYou({ lib }: { lib: LibraryState }) {
  const { busy, error, result, prompt: mood } = useSyncExternalStore(watchForYou, () => forYouState);
  const p = usePlayer();
  const [saved, setSaved] = useState("");
  useEffect(() => setSaved(""), [result]);
  const { ensure } = lib;
  useEffect(() => {
    if (result) void ensure(result.tracks.map((x) => x.id));
  }, [result, ensure]);

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
        {MOODS.map((m) => <button key={m} className={mood === m ? "active" : ""} aria-pressed={mood === m} onClick={() => setForYou({ prompt: mood === m ? "" : m })}>{m}</button>)}
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

function Playlists({ lib, uid }: { lib: LibraryState; uid: string }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const pls = [...lib.playlists.values()].sort((a, b) => a.name.localeCompare(b.name));
  const open = openId ? lib.playlists.get(openId) : undefined;
  // Playlists only hold ids: the open one is fetched whole, the others just enough to show a cover.
  const { ensure } = lib;
  const wanted = open ? open.trackIds : pls.flatMap((p) => p.trackIds.slice(0, 3));
  const wantedKey = wanted.join(",");
  useEffect(() => {
    void ensure(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantedKey, ensure]);

  const [creating, setCreating] = useState(false);

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
        {tracks.length === 0 && <p className="muted">Empty. In the Library tap Select (or ⋯ on a song) and choose Add to {open.name}.</p>}
      </>
    );
  }

  return (
    <>
      {creating && (
        <EditDialog
          title="New playlist"
          onClose={() => setCreating(false)}
          fields={[{ key: "name", label: "Playlist name", value: "", required: true }]}
          hint={() => ({ text: "Only you can see it until you share it with the family.", action: "Create" })}
          onSave={async (v) => {
            const id = crypto.randomUUID();
            await api.savePlaylist({ id, name: v.name.trim(), shared: false, trackIds: [] });
            await lib.refresh();
            setOpenId(id);
          }}
        />
      )}
      <button className="primary" onClick={() => setCreating(true)}>New playlist</button>
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
      {pls.length === 0 && <p className="muted">No playlists yet. Make one here, or in the Library tap Select, pick some songs and choose Add to…</p>}
    </>
  );
}

/** Owner tools for the shared library: where songs come from (YouTube, the NAS inbox) and keeping their names tidy. */
function LibraryTools({ lib, home, recheck }: { lib: LibraryState; home: ServerStatus | null; recheck: () => Promise<void> }) {
  const { refresh } = lib;
  const tracks = useMemo(() => [...lib.tracks.values()], [lib.tracks]);
  const [loadingAll, setLoadingAll] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [fixOpen, setFixOpen] = useState(false);
  const [fixSeen, setFixSeen] = useState(false);
  const down = home !== null && !home.ok;
  /** Reads the whole NAS library into the app. Reports progress in the status line; resolves to a summary, or null if it failed. */
  const syncNas = async (): Promise<string | null> => {
    let offset = 0;
    const ids: string[] = [];
    try {
      for (;;) {
        setOrganize({ msg: `Syncing the library… ${offset} songs` });
        const r = await api.syncNas(offset);
        offset = r.next;
        ids.push(...r.ids);
        if (r.done) break;
      }
      const { removed, skippedRemoval } = await api.finishNasSync(ids);
      return `${offset} songs${removed ? `, ${removed} removed` : ""}.` +
        (skippedRemoval ? ` Not removing ${skippedRemoval} songs: the NAS list looked incomplete.` : "");
    } catch (e) {
      setOrganize({ msg: e instanceof Error ? e.message : "Sync failed" });
      return null;
    } finally {
      await refresh();
    }
  };
  return (
    <>
      <div hidden={fixOpen}>
        <h2>Library tools</h2>
        <p className="muted">Everything here updates the shared library for the whole family. New songs show up in the Library by themselves when a job finishes.</p>
        <Organize syncNas={syncNas} home={home} recheck={recheck} />
        <section className="tool">
          <h3>Fix Vietnamese names</h3>
          <p className="muted">Finds Vietnamese titles, albums and artists with missing accents or wrong capitals. You pick which names to ask the AI about, and review every fix before it is saved.</p>
          <p>
            <button
              disabled={down || loadingAll}
              title={down ? home.error : undefined}
              onClick={async () => {
                // The fixer looks at every name, so this is the one place the whole library is read (once).
                setLoadError("");
                setLoadingAll(true);
                try {
                  if (!fixSeen) await lib.loadAll();
                  setFixSeen(true);
                  setFixOpen(true);
                  window.scrollTo(0, 0);
                } catch (e) {
                  setLoadError(e instanceof Error ? e.message : "Could not load the library");
                } finally {
                  setLoadingAll(false);
                }
              }}
            >{loadingAll ? "Loading the library…" : "Open the name fixer…"}</button>
            {loadError && <span className="error"> {loadError}</span>}
          </p>
        </section>
        <MissingAlbums tracks={tracks} refresh={refresh} />
      </div>
      {/* Its own page; kept mounted once opened so the scan and your edits survive going back. */}
      {fixSeen && (
        <div hidden={!fixOpen}>
          <FixVietnamese tracks={tracks} refresh={refresh} home={home} onBack={() => { setFixOpen(false); window.scrollTo(0, 0); }} />
        </div>
      )}
    </>
  );
}

/** Who is in the family, inviting people, and this person's own account. */
function Family({ family, uid, reload }: { family: FamilyInfo; uid: string; reload: () => Promise<void> }) {
  const isOwner = family.role === "owner";
  const [invite, setInvite] = useState<{ code: string; expiresAt: number } | null>(null);
  const [note, setNote] = useState("");
  const [taste, setTaste] = useState<Map<string, TasteProfile>>(new Map());
  useEffect(() => {
    let live = true;
    api.taste().then((ps) => live && setTaste(new Map(ps.map((p) => [p.uid, p])))).catch(() => {});
    return () => { live = false; };
  }, []);
  const createInvite = async () => {
    setNote("");
    try {
      setInvite(await api.invite());
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not create an invite");
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(invite!.code);
      setNote("Copied. Send it to the person you are inviting.");
    } catch {
      setNote("Could not copy. Select the code and copy it by hand.");
    }
  };
  return (
    <>
      <h2>{family.name}</h2>
      <ul>
        {family.members.map((m) => {
          const name = m.displayName || m.email;
          return (
            <li key={m.uid} className="row">
              <span className="grow">
                <strong>{name}{m.uid === uid && <small> (you)</small>}</strong>
                <small>{m.role === "owner" ? "Owner" : "Member"}{m.displayName && m.email ? ` · ${m.email}` : ""}</small>
                {(taste.get(m.uid)?.artists.length ?? 0) > 0 && (
                  <small className="muted">Top artists: {taste.get(m.uid)!.artists.map((a) => a.name).join(", ")}</small>
                )}
                {(taste.get(m.uid)?.tracks.length ?? 0) > 0 && (
                  <small className="muted">Top songs: {taste.get(m.uid)!.tracks.map((t) => t.title).join(", ")}</small>
                )}
              </span>
              {isOwner && m.uid !== uid && (
                <button className="link danger" aria-label={`Remove ${name}`} onClick={async () => {
                  if (confirm(`Remove ${name} from the family? They lose access and their playlists are deleted.`)) { await api.removeMember(m.uid); await reload(); }
                }}>Remove</button>
              )}
            </li>
          );
        })}
      </ul>
      {isOwner && (
        <section className="tool">
          <h3>Invite someone</h3>
          <p className="muted">They sign in, choose Join a family and enter the code.</p>
          {invite ? (
            <p>
              <code className="code">{invite.code}</code>{" "}
              <button onClick={() => void copy()}>Copy</button>{" "}
              <small className="muted">Works until {new Date(invite.expiresAt).toLocaleDateString()}</small>
            </p>
          ) : (
            <p><button onClick={() => void createInvite()}>Create invite code</button></p>
          )}
          {note && <p role="status"><small className="muted">{note}</small></p>}
        </section>
      )}
      <section className="tool">
        <h3>Your account</h3>
        <p>
          <button onClick={() => signOut()}>Sign out</button>{" "}
          <button className="link danger" onClick={async () => { if (confirm("Delete your account? You leave the family and your playlists are deleted. This cannot be undone.")) { await api.deleteAccount(); await auth.currentUser?.delete().catch(() => signOut()); } }}>Delete my account</button>
        </p>
        <p><small className="muted">Version {__APP_VERSION__}</small></p>
      </section>
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
/** A sync reads the whole library from the database, so while jobs keep finishing it runs this often at most. */
const SYNC_EVERY_MS = 5 * 60_000;

/**
 * Follows the open Beets runs until none is left (any number of YouTube songs, and one import or enrich), and scans
 * Navidrome and syncs the library after runs finish: at once when everything is done, at most once every five minutes while
 * more keep coming. It lives outside the component so it keeps going when you leave the Library tools tab, and the tab picks
 * it up again when you come back. `first` are runs the caller has just started, so one that ends before the first
 * look is still noticed.
 */
async function track(syncNas: () => Promise<string | null>, first: string[] = []) {
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
      // What a running job is doing is shown in its own card; the top line only carries scan, sync, done and failure messages.
      setOrganize({ runs, active: main, busy: main !== null, msg: open.length > 0 ? "" : organizeState.msg });
      if (pendingSync && (open.length === 0 || Date.now() - lastSyncAt > SYNC_EVERY_MS)) {
        pendingSync = false;
        setOrganize({ busy: true, msg: "Scanning Navidrome…" });
        await api.scanNas();
        await sleep(2000);
        for (let i = 0; i < 200 && (await api.nasScanning()).scanning; i++) await sleep(3000);
        setOrganize({ msg: "Syncing the library…" });
        const summary = await syncNas();
        doneMsg = summary !== null ? `Done: the library is up to date (${summary})` : "Beets ran, but the library sync failed.";
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

function Organize({ syncNas, home, recheck }: { syncNas: () => Promise<string | null>; home: ServerStatus | null; recheck: () => Promise<void> }) {
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
  const lookUp = async (links?: string[]) => {
    const urls = [...new Set((links ?? ytText.split(/\s+/)).filter(Boolean))].slice(0, 20);
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

  // A link sent by the "Add to MyMusic" bookmark (?yt=…) is looked up at once, so only the names are left to confirm.
  const incoming = useRef(incomingYoutube);
  useEffect(() => {
    const url = incoming.current;
    incoming.current = null;
    if (!url) return;
    setYtText(url);
    void lookUp([url]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The bookmark opens this app with the page's address. React refuses javascript: links, so it is set on the element.
  const bookmark = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    bookmark.current?.setAttribute("href", `javascript:void(window.open(${JSON.stringify(location.origin + "/?yt=")}+encodeURIComponent(location.href),"_blank"))`);
  }, []);

  return (
    <>
      {down && (
        <p className="error" role="alert">
          Home server unavailable: {home.error} <button className="link" onClick={() => void recheck()}>Check again</button>
        </p>
      )}
      {msg && (
        <p className="status" role="status">
          {busy && <span className="spinner" aria-hidden="true" />}
          {msg}
        </p>
      )}

      <section className="tool">
        <h3>Add songs from YouTube</h3>
        <p className="muted">Paste one link per line. Check the names, then add them. Songs are downloaded and added to the library for you.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (ytRows.length && !ytBusy) void addAll();
            else if (ytText.trim()) void lookUp();
          }}
        >
          <textarea
            className="yt-input"
            value={ytText}
            rows={4}
            placeholder={"https://youtu.be/…\nhttps://youtu.be/…\nhttps://youtu.be/…"}
            aria-label="YouTube links"
            spellCheck={false}
            disabled={ytBusy || down}
            onChange={(e) => {
              setYtText(e.target.value);
              setYtRows([]);
            }}
          />
          {ytRows.length === 0 && (
            <p><button type="submit" className="primary" disabled={ytBusy || down || !ytText.trim()}>{ytBusy ? "Looking up…" : "Look up"}</button></p>
          )}
          {ytRows.map((r) => (
            <fieldset key={r.url}>
              <legend><small className="muted">{r.url}</small></legend>
              {r.error && <p className="error" role="alert">{r.error}</p>}
              {!r.info && !r.error && <p><small className="muted">Looking up…</small></p>}
              {r.info && (
                <>
                  <div className="yt-fields">
                    <label>Title <input value={r.title} onChange={(e) => patchRow(r.url, { title: e.target.value })} /></label>
                    <label>Artist <input value={r.artist} onChange={(e) => patchRow(r.url, { artist: e.target.value })} /></label>
                    <label>Album (optional) <input value={r.album} onChange={(e) => patchRow(r.url, { album: e.target.value })} /></label>
                  </div>
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
              <button type="submit" className="primary" disabled={ytBusy || down || !ytRows.some(usable)}>
                Add {ytRows.filter(usable).length > 1 ? `${ytRows.filter(usable).length} songs` : "to library"}
              </button>{" "}
              <button type="button" className="link" disabled={ytBusy} onClick={() => { setYtRows([]); setYtText(""); }}>Start over</button>
            </p>
          )}
          {ytRows.length > 0 && !ytBusy && !ytRows.some(usable) && (
            <p><small className="muted">{ytHint(ytRows)}</small></p>
          )}
          {ytErr && <p className="error" role="alert">{ytErr}</p>}
        </form>
        <p>
          <small className="muted">
            One click from YouTube: drag <a ref={bookmark} className="link" onClick={(e) => e.preventDefault()}>Add to MyMusic</a> to your bookmarks bar, then click it while a video is open.
          </small>
        </p>
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
      </section>

      <section className="tool">
        <h3>Import from the NAS inbox</h3>
        <p className="muted">
          Put music files in the inbox folder on the NAS, then import them: they are sorted into the library, scanned and synced.
          {home?.ok && home.autoImport ? " Files added to the inbox are also imported automatically." : ""}
          {home?.ok && (home.waiting ?? 0) > 0 ? ` ${home.waiting} file${home.waiting === 1 ? "" : "s"} waiting in the inbox now.` : ""}
        </p>
        <p><button disabled={scanning || imp !== null || down} onClick={() => void organize()}>Import inbox and update library</button></p>
        {imp && (
          <p className="job" role="status">
            <span className="spinner" aria-hidden="true" />
            {imp.status === "requested" ? "Waiting for the server…" : "Beets is importing…"}
            {imp.status === "running" && imp.inboxBefore !== null && imp.inboxNow !== null && imp.inboxBefore > 0 && (
              <>
                {" "}<progress max={imp.inboxBefore} value={Math.max(0, imp.inboxBefore - imp.inboxNow)} />{" "}
                <small className="muted">{Math.max(0, imp.inboxBefore - imp.inboxNow)} of {imp.inboxBefore} files imported</small>
              </>
            )}
          </p>
        )}
      </section>

      <section className="tool">
        <h3>Covers and genres</h3>
        <p className="muted">Fetches missing cover art and genres for songs already in the library. This also runs every night.</p>
        <p><button disabled={scanning || enr !== null || down} onClick={() => void enrich()}>Fill in covers and genres now</button></p>
        {enr && (() => {
          // The server reports before = number of steps and now = steps still to do.
          const total = ENRICH_STEPS.length;
          const done = Math.min(total, Math.max(0, (enr.inboxBefore ?? total) - (enr.inboxNow ?? total)));
          const running = enr.status === "running";
          return (
            <p className="job" role="status">
              <span className="spinner" aria-hidden="true" />
              {!running ? "Waiting for the server…" : enr.inboxNow === null ? "Starting…" : (
                <>
                  <progress max={total} value={done} />{" "}
                  <small className="muted">Step {Math.min(total, done + 1)} of {total}: {ENRICH_STEPS[Math.min(total - 1, done)]}</small>
                </>
              )}
            </p>
          );
        })()}
      </section>

      {runs.length > 0 && (
        <details>
          <summary>History of imports and jobs</summary>
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
