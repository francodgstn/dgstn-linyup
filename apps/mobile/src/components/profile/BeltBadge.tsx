import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import type { RankBadge } from '@linyup/shared';

/**
 * A level's badge, drawn from the ONE resolved shape — `RankBadge`, the output
 * of @linyup/shared's `rankLevelBadge`: uploaded artwork, else an emoji, else
 * a split colour, else a solid one. This component switches on `kind` and
 * never re-derives that precedence from loose colour/emoji/image props, which
 * is what its previous version did (and what the shared function exists to
 * prevent — "which of these four fields wins" answered slightly differently
 * on every surface).
 *
 * A club identifies its levels the way its sport does — a belt colour here, a
 * sea animal at a swim school, a club's own artwork elsewhere — so this renders
 * all of them rather than assuming a belt.
 */
interface BeltBadgeProps {
  /** Null/undefined → a neutral placeholder disc (no level to show). */
  badge?: RankBadge | null;
  size?: number;
}

const PLACEHOLDER_COLOR = '#DDDDDD';

export const BeltBadge: React.FC<BeltBadgeProps> = ({ badge, size = 40 }) => {
  const round = { width: size, height: size, borderRadius: size / 2 };

  if (badge?.kind === 'image') {
    return <Image source={{ uri: badge.imageUrl }} style={[styles.badge, round]} resizeMode="cover" />;
  }

  if (badge?.kind === 'emoji') {
    return (
      <View style={[styles.badge, styles.emojiBox, round, { backgroundColor: badge.color ?? PLACEHOLDER_COLOR }]}>
        <Text style={{ fontSize: size * 0.55 }}>{badge.emoji}</Text>
      </View>
    );
  }

  if (badge?.kind === 'split') {
    return (
      <View style={[styles.badge, round, { backgroundColor: badge.color, overflow: 'hidden' }]}>
        <View
          style={{
            width: size,
            height: size / 2,
            backgroundColor: badge.secondColor,
            position: 'absolute',
            bottom: 0,
          }}
        />
      </View>
    );
  }

  return (
    <View style={[styles.badge, round, { backgroundColor: badge?.kind === 'solid' ? badge.color : PLACEHOLDER_COLOR }]} />
  );
};

const styles = StyleSheet.create({
  badge: {
    borderWidth: 2,
    borderColor: 'rgba(255, 255, 255, 0.2)',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.2,
    shadowRadius: 2,
  },
  emojiBox: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
