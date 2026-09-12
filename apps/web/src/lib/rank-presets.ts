import { withRankLevelIds, type RankLevel, type RankLevelInput } from '@linyup/shared'

export interface RankPreset {
  name: string
  levels: RankLevel[]
}

// Every preset level carries a deterministic id (see `withRankLevelIds`), so a
// system created from a preset is born with stable identities and two studios
// applying the same preset get the same ids — the exported list is the RAW one
// below, mapped once at module load.
const RAW_PRESETS: { name: string; levels: RankLevelInput[] }[] = [
  {
    name: 'Hwal Moo Do',
    levels: [
      { label: 'No belt',       color: '#AAAAAA' },
      { label: 'White',          color: '#DDDDDD' },
      { label: 'Yellow',         color: '#FFDC00' },
      { label: 'Orange',         color: '#FF851B' },
      { label: 'Orange/Green',   color: '#FF851B', secondColor: '#1c9c2b' },
      { label: 'Green',          color: '#1c9c2b' },
      { label: 'Green/Blue',     color: '#1c9c2b', secondColor: '#0074D9' },
      { label: 'Blue',           color: '#0074D9' },
      { label: 'Blue/Red',       color: '#0074D9', secondColor: '#d41010' },
      { label: 'Red',            color: '#d41010' },
      { label: 'Red/Black',      color: '#d41010', secondColor: '#111111' },
      { label: 'Black I Dan',    color: '#111111' },
      { label: 'Black II Dan',   color: '#111111' },
      { label: 'Black III Dan',  color: '#111111' },
      { label: 'Master',         color: '#111111' },
    ],
  },
  {
    name: 'BJJ Belts',
    levels: [
      { label: 'White',  color: '#E5E7EB' },
      { label: 'Blue',   color: '#3B82F6' },
      { label: 'Purple', color: '#8B5CF6' },
      { label: 'Brown',  color: '#92400E' },
      { label: 'Black',  color: '#111111' },
    ],
  },
  {
    name: 'Judo Kyu/Dan',
    levels: [
      { label: '6th Kyu (White)',  color: '#E5E7EB' },
      { label: '5th Kyu (Yellow)', color: '#FFDC00' },
      { label: '4th Kyu (Orange)', color: '#FF851B' },
      { label: '3rd Kyu (Green)',  color: '#1c9c2b' },
      { label: '2nd Kyu (Blue)',   color: '#0074D9' },
      { label: '1st Kyu (Brown)',  color: '#92400E' },
      { label: '1st Dan (Black)',  color: '#111111' },
      { label: '2nd Dan (Black)',  color: '#111111' },
      { label: '3rd Dan (Black)',  color: '#111111' },
    ],
  },
  {
    // Swiss swimming — swimsports.ch. Seven animal-named foundation tests
    // (Grundlagentests), then three stroke-proficiency levels.
    //
    //   1 Krebs        safe entry and exit, eyes open underwater, breathing
    //   2 Seepferd     gliding on front and back, no leg movement
    //   3 Frosch       10 m alternating leg kick, front and back
    //   4 Pinguin      10 m proper backstroke
    //   5 Tintenfisch  six complete front-crawl cycles
    //   6 Krokodil     25 m backstroke including a start
    //   7 Eisbär       includes the official Water Safety Check (WSC)
    //   8-9            breaststroke and elementary butterfly: introduction, then distance
    //   10             50 m crawl/backstroke with flip turns, 25 m breaststroke/butterfly
    //
    // The WSC is part of Eisbär, not a level of its own. Levels 8-10 are labelled
    // by what they test, because they have no animal name — a club renames them
    // to whatever its own material calls them.
    //
    // The animals carry an emoji: a seven-year-old recognises the penguin long
    // before they read "Pinguin". (Seepferd takes a fish — Unicode has no
    // seahorse.)
    name: 'Swiss Swimming (swimsports.ch)',
    levels: [
      { label: 'Krebs',        color: '#E24B4A', emoji: '🦀' },
      { label: 'Seepferd',     color: '#FFDC00', emoji: '🐠' },
      { label: 'Frosch',       color: '#1c9c2b', emoji: '🐸' },
      { label: 'Pinguin',      color: '#0074D9', emoji: '🐧' },
      { label: 'Tintenfisch',  color: '#8B5CF6', emoji: '🦑' },
      { label: 'Krokodil',     color: '#0F6E56', emoji: '🐊' },
      { label: 'Eisbär (WSC)', color: '#93C5FD', emoji: '🐻‍❄️' },
      { label: 'Brust & Delfin — Einführung', color: '#2B6CB0', emoji: '🏊' },
      { label: 'Brust & Delfin — Distanz',    color: '#1E40AF', emoji: '🏊' },
      { label: 'Schwimmtest',  color: '#1A365D', emoji: '🏅' },
    ],
  },
  {
    // Generic learn-to-swim progression (stroke-based), for non-Swiss swim schools.
    name: 'Swimming — Learn to Swim',
    levels: [
      { label: 'Water confidence', color: '#BEE3F8' },
      { label: 'Floating & gliding', color: '#90CDF4' },
      { label: 'Front crawl',      color: '#63B3ED' },
      { label: 'Backstroke',       color: '#4299E1' },
      { label: 'Breaststroke',     color: '#3182CE' },
      { label: 'Butterfly',        color: '#2B6CB0' },
      { label: 'All strokes',      color: '#2C5282' },
      { label: 'Squad / advanced', color: '#1A365D' },
    ],
  },
  {
    name: 'Gymnastics — Badges',
    levels: [
      { label: 'Beginner',  color: '#9CA3AF' },
      { label: 'Bronze',    color: '#B45309' },
      { label: 'Silver',    color: '#94A3B8' },
      { label: 'Gold',      color: '#F59E0B' },
      { label: 'Platinum',  color: '#22D3EE' },
      { label: 'Elite',     color: '#EF4444' },
    ],
  },
  {
    name: 'Dance — Grades',
    levels: [
      { label: 'Pre-Primary', color: '#F9A8D4' },
      { label: 'Primary',     color: '#F472B6' },
      { label: 'Grade 1',     color: '#EC4899' },
      { label: 'Grade 2',     color: '#DB2777' },
      { label: 'Grade 3',     color: '#A21CAF' },
      { label: 'Grade 4',     color: '#7E22CE' },
      { label: 'Grade 5',     color: '#6D28D9' },
      { label: 'Intermediate', color: '#4F46E5' },
      { label: 'Advanced',    color: '#1E40AF' },
    ],
  },
  {
    name: '5-Level Generic',
    levels: [
      { label: 'Beginner',     color: '#9CA3AF' },
      { label: 'Elementary',   color: '#60A5FA' },
      { label: 'Intermediate', color: '#34D399' },
      { label: 'Advanced',     color: '#F59E0B' },
      { label: 'Expert',       color: '#EF4444' },
    ],
  },
]

export const RANK_PRESETS: RankPreset[] = RAW_PRESETS.map((p) => ({
  ...p,
  levels: withRankLevelIds(p.levels),
}))
