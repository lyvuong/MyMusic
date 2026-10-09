import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";

interface RatingsValue {
  /** Your 1-5 star rating per track id; songs you have not rated are absent. */
  ratings: Record<string, number>;
  /** Sets a rating (0 clears it). Shown at once and put back if the server refuses. */
  rate: (trackId: string, stars: number) => void;
}

const Ctx = createContext<RatingsValue>({ ratings: {}, rate: () => undefined });
export const useRatings = () => useContext(Ctx);

export function RatingsProvider({ children }: { children: ReactNode }) {
  const [ratings, setRatings] = useState<Record<string, number>>({});

  useEffect(() => {
    api.ratings().then((r) => setRatings(r.ratings)).catch(() => undefined);
  }, []);

  const rate = useCallback((trackId: string, stars: number) => {
    let before = 0;
    setRatings((old) => {
      before = old[trackId] ?? 0;
      const n = { ...old };
      if (stars === 0) delete n[trackId];
      else n[trackId] = stars;
      return n;
    });
    api.rateTrack(trackId, stars).catch(() => {
      setRatings((old) => {
        const n = { ...old };
        if (before === 0) delete n[trackId];
        else n[trackId] = before;
        return n;
      });
    });
  }, []);

  const value = useMemo(() => ({ ratings, rate }), [ratings, rate]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Five stars; tapping the star that matches the current rating clears it. */
export function Stars({ trackId, title }: { trackId: string; title: string }) {
  const { ratings, rate } = useRatings();
  const mine = ratings[trackId] ?? 0;
  return (
    <span className="stars" role="group" aria-label={`Rate ${title}`} onClick={(e) => e.stopPropagation()}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          className={n <= mine ? "star on" : "star"}
          aria-label={`${n} star${n === 1 ? "" : "s"}`}
          aria-pressed={n === mine}
          onClick={() => rate(trackId, n === mine ? 0 : n)}
        >
          {n <= mine ? "★" : "☆"}
        </button>
      ))}
    </span>
  );
}
