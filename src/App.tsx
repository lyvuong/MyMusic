import { onAuthStateChanged, type User } from "firebase/auth";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { FamilyInfo, Playlist, Track } from "../shared/types";
import { api } from "./api";
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
      <h1>MyMusic</h1>
      <p>Your family&apos;s music, anywhere.</p>
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
        <h1>MyMusic <small>{family.name}</small></h1>
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

function TrackRow({ t, queue, extra }: { t: Track; queue: Track[]; extra?: React.ReactNode }) {
  const p = usePlayer();
  const active = p.current?.id === t.id;
  return (
    <li className={active ? "row active" : "row"}>
      <button className="play" onClick={() => p.play(queue, queue.findIndex((x) => x.id === t.id))}>{active && p.playing ? "♪" : "▶"}</button>
      <span className="grow"><strong>{t.title}</strong><small>{[t.artist, t.album].filter(Boolean).join(" · ")}</small></span>
      {extra}
    </li>
  );
}

function Library({ tracks, playlists, uid, refresh }: { tracks: Track[]; playlists: Playlist[]; uid: string; refresh: () => Promise<void> }) {
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const s = q.toLowerCase();
    return tracks
      .filter((t) => !s || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(s))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [tracks, q]);
  const mine = playlists.filter((p) => p.ownerUid === uid);

  const addTo = async (pl: Playlist, t: Track) => {
    if (pl.trackIds.includes(t.id)) return;
    await api.savePlaylist({ ...pl, trackIds: [...pl.trackIds, t.id] });
    await refresh();
  };

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

  return (
    <>
      <input className="search" placeholder="Search your music" value={q} onChange={(e) => setQ(e.target.value)} />
      {tracks.some((t) => !t.hasArt && t.source === "r2") && (
        <p className="muted">
          Some songs have no cover. <button className="link" onClick={() => void findCovers()}>Find missing covers online</button> {artMsg}
        </p>
      )}
      {list.length === 0 ? (
        <p className="muted">No songs yet. Add music to your NAS, then run "Sync music from NAS" in the Family tab.</p>
      ) : (
        <ul>
          {list.map((t) => (
            <TrackRow
              key={t.id}
              t={t}
              queue={list}
              extra={
                <>
                  {mine.length > 0 && (
                    <select value="" onChange={(e) => { const pl = mine.find((p) => p.id === e.target.value); if (pl) void addTo(pl, t); }} aria-label="Add to playlist">
                      <option value="">＋ Playlist</option>
                      {mine.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  )}
                  <button className="link danger" onClick={async () => { if (confirm(`Delete "${t.title}" for the whole family?`)) { await api.deleteTrack(t.id); await refresh(); } }}>Delete</button>
                </>
              }
            />
          ))}
        </ul>
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
  const syncNas = async () => {
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
    } catch (e) {
      setNasMsg(e instanceof Error ? e.message : "Sync failed");
    }
    await refresh();
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
