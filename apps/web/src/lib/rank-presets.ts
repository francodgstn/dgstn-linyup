import { withRankLevelIds, type RankLevel } from '@linyup/shared'

export interface RankPreset {
  name: string
  levels: RankLevel[]
}

// Every preset level carries a deterministic id (see `withRankLevelIds`), so a
// system created from a preset is born with stable identities and two studios
// applying the same preset get the same ids — the exported list is the RAW one
// below, mapped once at module load.
const RAW_PRESETS: RankPreset[] = [
  {
    name: 'Hwal Moo Do',
    levels: [
      { value: 0,  label: 'No belt',       color: '#AAAAAA' },
      { value: 1,  label: 'White',          color: '#DDDDDD' },
      { value: 2,  label: 'Yellow',         color: '#FFDC00' },
      { value: 3,  label: 'Orange',         color: '#FF851B' },
      { value: 4,  label: 'Orange/Green',   color: '#FF851B', secondColor: '#1c9c2b' },
      { value: 5,  label: 'Green',          color: '#1c9c2b' },
      { value: 6,  label: 'Green/Blue',     color: '#1c9c2b', secondColor: '#0074D9' },
      { value: 7,  label: 'Blue',           color: '#0074D9' },
      { value: 8,  label: 'Blue/Red',       color: '#0074D9', secondColor: '#d41010' },
      { value: 9,  label: 'Red',            color: '#d41010' },
      { value: 10, label: 'Red/Black',      color: '#d41010', secondColor: '#111111' },
      { value: 11, label: 'Black I Dan',    color: '#111111' },
      { value: 12, label: 'Black II Dan',   color: '#111111' },
      { value: 13, label: 'Black III Dan',  color: '#111111' },
      { value: 14, label: 'Master',         color: '#111111' },
    ],
  },
  {
    name: 'BJJ Belts',
    levels: [
      { value: 0, label: 'White',  color: '#E5E7EB' },
      { value: 1, label: 'Blue',   color: '#3B82F6' },
      { value: 2, label: 'Purple', color: '#8B5CF6' },
      { value: 3, label: 'Brown',  color: '#92400E' },
      { value: 4, label: 'Black',  color: '#111111' },
    ],
  },
  {
    name: 'Judo Kyu/Dan',
    levels: [
      { value: 0, label: '6th Kyu (White)',  color: '#E5E7EB' },
      { value: 1, label: '5th Kyu (Yellow)', color: '#FFDC00' },
      { value: 2, label: '4th Kyu (Orange)', color: '#FF851B' },
      { value: 3, label: '3rd Kyu (Green)',  color: '#1c9c2b' },
      { value: 4, label: '2nd Kyu (Blue)',   color: '#0074D9' },
      { value: 5, label: '1st Kyu (Brown)',  color: '#92400E' },
      { value: 6, label: '1st Dan (Black)',  color: '#111111' },
      { value: 7, label: '2nd Dan (Black)',  color: '#111111' },
      { value: 8, label: '3rd Dan (Black)',  color: '#111111' },
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
      { value: 0, label: 'Krebs',        color: '#E24B4A', emoji: '🦀' },
      { value: 1, label: 'Seepferd',     color: '#FFDC00', emoji: '🐠' },
      { value: 2, label: 'Frosch',       color: '#1c9c2b', emoji: '🐸' },
      { value: 3, label: 'Pinguin',      color: '#0074D9', emoji: '🐧' },
      { value: 4, label: 'Tintenfisch',  color: '#8B5CF6', emoji: '🦑' },
      { value: 5, label: 'Krokodil',     color: '#0F6E56', emoji: '🐊' },
      { value: 6, label: 'Eisbär (WSC)', color: '#93C5FD', emoji: '🐻‍❄️' },
      { value: 7, label: 'Brust & Delfin — Einführung', color: '#2B6CB0', emoji: '🏊' },
      { value: 8, label: 'Brust & Delfin — Distanz',    color: '#1E40AF', emoji: '🏊' },
      { value: 9, label: 'Schwimmtest',  color: '#1A365D', emoji: '🏅' },
    ],
  },
  {
    // Generic learn-to-swim progression (stroke-based), for non-Swiss swim schools.
    name: 'Swimming — Learn to Swim',
    levels: [
      { value: 0, label: 'Water confidence', color: '#BEE3F8' },
      { value: 1, label: 'Floating & gliding', color: '#90CDF4' },
      { value: 2, label: 'Front crawl',      color: '#63B3ED' },
      { value: 3, label: 'Backstroke',       color: '#4299E1' },
      { value: 4, label: 'Breaststroke',     color: '#3182CE' },
      { value: 5, label: 'Butterfly',        color: '#2B6CB0' },
      { value: 6, label: 'All strokes',      color: '#2C5282' },
      { value: 7, label: 'Squad / advanced', color: '#1A365D' },
    ],
  },
  {
    name: 'Gymnastics — Badges',
    levels: [
      { value: 0, label: 'Beginner',  color: '#9CA3AF' },
      { value: 1, label: 'Bronze',    color: '#B45309' },
      { value: 2, label: 'Silver',    color: '#94A3B8' },
      { value: 3, label: 'Gold',      color: '#F59E0B' },
      { value: 4, label: 'Platinum',  color: '#22D3EE' },
      { value: 5, label: 'Elite',     color: '#EF4444' },
    ],
  },
  {
    name: 'Dance — Grades',
    levels: [
      { value: 0, label: 'Pre-Primary', color: '#F9A8D4' },
      { value: 1, label: 'Primary',     color: '#F472B6' },
      { value: 2, label: 'Grade 1',     color: '#EC4899' },
      { value: 3, label: 'Grade 2',     color: '#DB2777' },
      { value: 4, label: 'Grade 3',     color: '#A21CAF' },
      { value: 5, label: 'Grade 4',     color: '#7E22CE' },
      { value: 6, label: 'Grade 5',     color: '#6D28D9' },
      { value: 7, label: 'Intermediate', color: '#4F46E5' },
      { value: 8, label: 'Advanced',    color: '#1E40AF' },
    ],
  },
  {
    name: '5-Level Generic',
    levels: [
      { value: 0, label: 'Beginner',     color: '#9CA3AF' },
      { value: 1, label: 'Elementary',   color: '#60A5FA' },
      { value: 2, label: 'Intermediate', color: '#34D399' },
      { value: 3, label: 'Advanced',     color: '#F59E0B' },
      { value: 4, label: 'Expert',       color: '#EF4444' },
    ],
  },
]

export const RANK_PRESETS: RankPreset[] = RAW_PRESETS.map((p) => ({
  ...p,
  levels: withRankLevelIds(p.levels),
}))
