import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, View } from 'react-native';
import {
  ActivityIndicator,
  Button,
  Card,
  Chip,
  Icon,
  Modal,
  Portal,
  Text,
  TextInput,
  TouchableRipple,
  useTheme,
} from 'react-native-paper';
import DateTimePicker from '@react-native-community/datetimepicker';
import { FirestoreService } from '../../services/firestore';
import { Goal, GoalEvaluation, GoalStatus, PerformanceIndicator } from '../../types';
import { dimensionLabel, goalCategoryLabel, groupGoalsWithSteps, sortSteps, GOAL_STATUSES } from '../../utils/goalContract';
import { Timestamp } from 'firebase/firestore';
import { useTranslations } from '../../i18n';

interface Props {
  contactId: string;
  teamId: string;
}

/** What the module-level helpers need from `useTranslations('Goals')`. */
type Translate = (key: string, values?: Record<string, string | number>) => string;

// ─── Status helpers ──────────────────────────────────────────────────────────

const statusLabel = (t: Translate, status: GoalStatus): string => {
  switch (status) {
    case 'open': return t('statusOpen');
    case 'in_progress': return t('statusInProgress');
    case 'achieved': return t('statusAchieved');
    case 'abandoned': return t('statusAbandoned');
  }
};

const STATUS_COLORS: Record<GoalStatus, string> = {
  open: '#3B82F6',
  in_progress: '#F97316',
  achieved: '#22C55E',
  abandoned: '#9CA3AF',
};


// Categories are the team's resolved GOAL CATEGORIES — what a goal is about
// (FirestoreService.getGoalCategories). They are NOT the check-in axes, which
// say how someone is doing; the two lists were briefly merged and are separate
// again — see the header of packages/shared/src/types/goal.ts. The axes are
// still loaded here, for one job only: labelling a goal's `from_dimension`
// provenance chip, which records the axis a goal was created FROM.

function formatGoalDate(value: any): string {
  const d = value?.toDate ? value.toDate() : typeof value === 'string' ? new Date(value) : null;
  return d ? d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }) : '';
}

// ─── Star rating display ─────────────────────────────────────────────────────

const StarDisplay: React.FC<{ score: number; size?: number }> = ({ score, size = 14 }) => {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => (
        <Icon
          key={i}
          source={i <= score ? 'star' : 'star-outline'}
          size={size}
          color={i <= score ? '#F59E0B' : theme.colors.onSurfaceVariant}
        />
      ))}
    </View>
  );
};

// ─── Touchable stars for input ────────────────────────────────────────────────
// `value` of 0 renders as "unrated" — nothing filled in.

const StarInput: React.FC<{ value: number; onChange: (v: number) => void }> = ({ value, onChange }) => (
  <View style={{ flexDirection: 'row', gap: 8 }}>
    {[1, 2, 3, 4, 5].map(i => (
      <TouchableRipple key={i} onPress={() => onChange(i)} borderless style={{ borderRadius: 20 }}>
        <Icon source={i <= value ? 'star' : 'star-outline'} size={32} color={i <= value ? '#F59E0B' : '#9CA3AF'} />
      </TouchableRipple>
    ))}
  </View>
);

// ─── Evaluation history item ──────────────────────────────────────────────────

interface EvaluationItemProps {
  eval_: GoalEvaluation;
  onEdit?: () => void;
}

const EvaluationItem: React.FC<EvaluationItemProps> = ({ eval_, onEdit }) => {
  const theme = useTheme();
  const t = useTranslations('Goals');
  const date = eval_.evaluated_at.toDate();
  const dateStr = date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    <View
      style={{
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderLeftWidth: 3,
        borderLeftColor: STATUS_COLORS[eval_.status_after],
        marginBottom: 8,
        backgroundColor: theme.colors.surfaceVariant,
        borderRadius: 6,
      }}
    >
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
        <StarDisplay score={eval_.score} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          {eval_.edited && (
            <Chip compact style={{ backgroundColor: theme.colors.surfaceVariant }} textStyle={{ fontSize: 9, color: theme.colors.onSurfaceVariant }}>
              {t('editedTag')}
            </Chip>
          )}
          <Chip
            compact
            style={{ backgroundColor: eval_.evaluated_by === 'coach' ? '#7C3AED20' : '#3B82F620' }}
            textStyle={{ fontSize: 10 }}
          >
            {eval_.evaluated_by === 'coach' ? t('filledByCoach') : t('filledBySelf')}
          </Chip>
          {onEdit && (
            <TouchableRipple onPress={onEdit} borderless style={{ borderRadius: 12 }}>
              <Icon source="pencil-outline" size={16} color={theme.colors.onSurfaceVariant} />
            </TouchableRipple>
          )}
        </View>
      </View>
      <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
        {t('dateStatusLine', { date: dateStr, status: statusLabel(t, eval_.status_after) })}
      </Text>
      {eval_.notes ? (
        <Text variant="bodySmall" style={{ color: theme.colors.onSurface, marginTop: 4 }}>
          {eval_.notes}
        </Text>
      ) : null}
    </View>
  );
};

// ─── Add / Edit Evaluation Modal ─────────────────────────────────────────────

interface EvalModalProps {
  visible: boolean;
  currentStatus: GoalStatus;
  /** False for a coach-created goal: firestore.rules only lets a member move
   *  a goal's status when they created it, so the picker for "what status did
   *  this evaluation leave the goal in" is not offered — the score + note
   *  still save on their own. */
  allowStatusChange: boolean;
  initialScore?: number;
  initialNotes?: string | null;
  initialStatusAfter?: GoalStatus;
  onDismiss: () => void;
  onSubmit: (score: number, notes: string, statusAfter: GoalStatus) => Promise<void>;
}

const AddEvalModal: React.FC<EvalModalProps> = ({
  visible,
  currentStatus,
  allowStatusChange,
  initialScore,
  initialNotes,
  initialStatusAfter,
  onDismiss,
  onSubmit,
}) => {
  const theme = useTheme();
  const t = useTranslations('Goals');
  // Unset until the member actually taps a star — a default of 3 let a save
  // happen with zero interaction.
  const [score, setScore] = useState<number | null>(initialScore ?? null);
  const [notes, setNotes] = useState(initialNotes ?? '');
  const [statusAfter, setStatusAfter] = useState<GoalStatus>(initialStatusAfter ?? currentStatus);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setScore(initialScore ?? null);
      setNotes(initialNotes ?? '');
      setStatusAfter(initialStatusAfter ?? currentStatus);
    }
  }, [visible, currentStatus, initialScore, initialNotes, initialStatusAfter]);

  const handleSubmit = async () => {
    if (score === null) return;
    setSubmitting(true);
    try {
      await onSubmit(score, notes.trim(), statusAfter);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={{
          backgroundColor: theme.colors.surface,
          margin: 20,
          borderRadius: 16,
          padding: 20,
          gap: 16,
        }}
      >
        <Text variant="titleMedium" style={{ fontWeight: '700' }}>
          {initialScore !== undefined ? t('editEvaluationTitle') : t('addEvaluationTitle')}
        </Text>

        <View>
          <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
            {t('scoreLabel')}
          </Text>
          <StarInput value={score ?? 0} onChange={setScore} />
        </View>

        <TextInput
          label={t('notesOptional')}
          value={notes}
          onChangeText={setNotes}
          multiline
          numberOfLines={3}
          mode="outlined"
          style={{ backgroundColor: theme.colors.surface }}
        />

        {allowStatusChange ? (
          <View>
            <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
              {t('statusAfterLabel')}
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {GOAL_STATUSES.map(s => (
                <Chip
                  key={s}
                  selected={statusAfter === s}
                  onPress={() => setStatusAfter(s)}
                  style={statusAfter === s ? { backgroundColor: STATUS_COLORS[s] + '30' } : undefined}
                  textStyle={statusAfter === s ? { color: STATUS_COLORS[s], fontWeight: '700' } : undefined}
                >
                  {statusLabel(t, s)}
                </Chip>
              ))}
            </View>
          </View>
        ) : (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant }}>
            {t('recordedAgainstStatus', { status: statusLabel(t, currentStatus) })}
          </Text>
        )}

        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          <Button onPress={onDismiss} disabled={submitting}>{t('cancel')}</Button>
          <Button mode="contained" onPress={handleSubmit} loading={submitting} disabled={submitting || score === null}>
            {t('save')}
          </Button>
        </View>
      </Modal>
    </Portal>
  );
};

// ─── Add Goal Modal ───────────────────────────────────────────────────────────

interface AddGoalModalProps {
  visible: boolean;
  categoryOptions: PerformanceIndicator[];
  initialTitle?: string;
  initialDescription?: string | null;
  initialCategories?: string[];
  initialTargetDate?: Date | null;
  onDismiss: () => void;
  onSubmit: (title: string, description: string, categories: string[], targetDate: Date | null) => Promise<void>;
}

const AddGoalModal: React.FC<AddGoalModalProps> = ({
  visible,
  categoryOptions,
  initialTitle,
  initialDescription,
  initialCategories,
  initialTargetDate,
  onDismiss,
  onSubmit,
}) => {
  const theme = useTheme();
  const t = useTranslations('Goals');
  const isEditing = initialTitle !== undefined;
  const [title, setTitle] = useState(initialTitle ?? '');
  const [description, setDescription] = useState(initialDescription ?? '');
  const [selectedCategories, setSelectedCategories] = useState<string[]>(initialCategories ?? []);
  const [targetDate, setTargetDate] = useState<Date | null>(initialTargetDate ?? null);
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (visible) {
      setTitle(initialTitle ?? '');
      setDescription(initialDescription ?? '');
      setSelectedCategories(initialCategories ?? []);
      setTargetDate(initialTargetDate ?? null);
      setShowDatePicker(false);
    }
  }, [visible, initialTitle, initialDescription, initialCategories, initialTargetDate]);

  const toggleCategory = (key: string) => {
    setSelectedCategories(prev =>
      prev.includes(key) ? prev.filter(k => k !== key) : [...prev, key]
    );
  };

  const handleSubmit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await onSubmit(title.trim(), description.trim(), selectedCategories, targetDate);
    } finally {
      setSubmitting(false);
    }
  };

  const formattedDate = targetDate
    ? targetDate.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
    : null;

  return (
    <Portal>
      <Modal
        visible={visible}
        onDismiss={onDismiss}
        contentContainerStyle={{
          backgroundColor: theme.colors.surface,
          margin: 20,
          borderRadius: 16,
          padding: 20,
          gap: 16,
        }}
      >
        <Text variant="titleMedium" style={{ fontWeight: '700' }}>{isEditing ? t('editGoalTitle') : t('addGoalTitle')}</Text>

        <TextInput
          label={t('titleLabel')}
          value={title}
          onChangeText={setTitle}
          mode="outlined"
          style={{ backgroundColor: theme.colors.surface }}
        />

        <TextInput
          label={t('descriptionOptional')}
          value={description}
          onChangeText={setDescription}
          multiline
          numberOfLines={3}
          mode="outlined"
          style={{ backgroundColor: theme.colors.surface }}
        />

        <View>
          <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
            {t('categoriesLabel')}
          </Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {categoryOptions.map(cat => (
              <Chip
                key={cat.key}
                selected={selectedCategories.includes(cat.key)}
                onPress={() => toggleCategory(cat.key)}
              >
                {cat.label}
              </Chip>
            ))}
          </View>
        </View>

        <View>
          <Text variant="labelMedium" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
            {t('targetDateOptional')}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <TouchableRipple
              onPress={() => setShowDatePicker(true)}
              style={{
                flex: 1,
                borderWidth: 1,
                borderColor: theme.colors.outline,
                borderRadius: 4,
                paddingVertical: 12,
                paddingHorizontal: 14,
              }}
            >
              <Text variant="bodyMedium" style={{ color: formattedDate ? theme.colors.onSurface : theme.colors.onSurfaceVariant }}>
                {formattedDate ?? t('selectDate')}
              </Text>
            </TouchableRipple>
            {targetDate && (
              <TouchableRipple onPress={() => setTargetDate(null)} borderless style={{ borderRadius: 16 }}>
                <Icon source="close-circle-outline" size={22} color={theme.colors.onSurfaceVariant} />
              </TouchableRipple>
            )}
          </View>
          {showDatePicker && (
            <DateTimePicker
              value={targetDate ?? new Date()}
              mode="date"
              display={Platform.OS === 'ios' ? 'inline' : 'default'}
              minimumDate={new Date()}
              onChange={(_, date) => {
                if (Platform.OS === 'android') setShowDatePicker(false);
                if (date) setTargetDate(date);
              }}
            />
          )}
          {Platform.OS === 'ios' && showDatePicker && (
            <Button compact onPress={() => setShowDatePicker(false)} style={{ alignSelf: 'flex-end' }}>
              {t('done')}
            </Button>
          )}
        </View>

        <View style={{ flexDirection: 'row', justifyContent: 'flex-end', gap: 8 }}>
          <Button onPress={onDismiss} disabled={submitting}>{t('cancel')}</Button>
          <Button
            mode="contained"
            onPress={handleSubmit}
            loading={submitting}
            disabled={submitting || !title.trim()}
          >
            {isEditing ? t('save') : t('addGoalTitle')}
          </Button>
        </View>
      </Modal>
    </Portal>
  );
};

// ─── Task row ─────────────────────────────────────────────────────────────────
// A task is boolean homework: no star evaluation, just done / not done.
// Mirrors the web admin's TaskCard.toggleDone.

interface TaskRowProps {
  task: Goal;
  contactId: string;
  onChanged: () => void;
  nested?: boolean;
}

const TaskRow: React.FC<TaskRowProps> = ({ task, contactId, onChanged, nested }) => {
  const theme = useTheme();
  const t = useTranslations('Goals');
  const [toggling, setToggling] = useState(false);
  const isDone = task.status === 'achieved';

  const handleToggle = async () => {
    setToggling(true);
    try {
      await FirestoreService.updateGoal(
        contactId,
        task.id,
        isDone
          ? { status: 'open', completed_at: null }
          : { status: 'achieved', completed_at: Timestamp.now() },
      );
      onChanged();
    } catch (error) {
      console.error('Error toggling task:', error);
      Alert.alert(t('taskUpdateFailedTitle'), t('taskUpdateFailedBody'));
    } finally {
      setToggling(false);
    }
  };

  const targetDateStr = task.target_date ? formatGoalDate(task.target_date) : null;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        padding: nested ? 10 : 14,
        marginLeft: nested ? 14 : 0,
        marginBottom: 8,
        borderRadius: 10,
        backgroundColor: nested ? theme.colors.surfaceVariant : theme.colors.surface,
        borderWidth: nested ? 0 : 1,
        borderColor: theme.colors.outlineVariant,
      }}
    >
      <TouchableRipple onPress={handleToggle} disabled={toggling} borderless style={{ borderRadius: 14, marginTop: 1 }}>
        <Icon
          source={isDone ? 'check-circle' : 'circle-outline'}
          size={22}
          color={isDone ? '#22C55E' : theme.colors.onSurfaceVariant}
        />
      </TouchableRipple>
      <View style={{ flex: 1 }}>
        <Text
          variant="bodyMedium"
          style={{
            color: isDone ? theme.colors.onSurfaceVariant : theme.colors.onSurface,
            fontWeight: '600',
            textDecorationLine: isDone ? 'line-through' : 'none',
          }}
        >
          {task.title}
        </Text>
        {task.description ? (
          <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}>
            {task.description}
          </Text>
        ) : null}
        {targetDateStr ? (
          <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant, marginTop: 4 }}>
            {t('targetPrefix', { date: targetDateStr })}
          </Text>
        ) : null}
      </View>
    </View>
  );
};

// ─── Goal Card ────────────────────────────────────────────────────────────────

interface GoalCardProps {
  goal: Goal;
  steps: Goal[];
  contactId: string;
  categoryOptions: PerformanceIndicator[];
  /** Check-in axes — used ONLY to label the `from_dimension` provenance chip. */
  dimensionOptions: PerformanceIndicator[];
  onEvaluationAdded: () => void;
  onEditGoal?: () => void;
  onDeleteGoal?: () => void;
}

const GoalCard: React.FC<GoalCardProps> = ({ goal, steps, contactId, categoryOptions, dimensionOptions, onEvaluationAdded, onEditGoal, onDeleteGoal }) => {
  const theme = useTheme();
  const t = useTranslations('Goals');
  const [expanded, setExpanded] = useState(false);
  const [evaluations, setEvaluations] = useState<GoalEvaluation[]>([]);
  const [loadingEvals, setLoadingEvals] = useState(false);
  const [showEvalModal, setShowEvalModal] = useState(false);
  const [editingEval, setEditingEval] = useState<GoalEvaluation | null>(null);

  // firestore.rules only lets a member move a goal's status when they
  // created it themselves — a coach's goal is the coach's to move.
  const allowStatusChange = goal.created_by === 'student';

  const loadEvaluations = useCallback(async () => {
    setLoadingEvals(true);
    try {
      const evals = await FirestoreService.getGoalEvaluations(contactId, goal.id);
      setEvaluations(evals);
    } finally {
      setLoadingEvals(false);
    }
  }, [contactId, goal.id]);

  const handleExpand = () => {
    if (!expanded) {
      loadEvaluations();
    }
    setExpanded(e => !e);
  };

  const handleAddEval = async (score: number, notes: string, statusAfter: GoalStatus) => {
    await FirestoreService.addGoalEvaluation(
      contactId,
      goal.id,
      {
        evaluated_at: Timestamp.now(),
        evaluated_by: 'student',
        score,
        notes: notes || null,
        status_after: statusAfter,
      },
      goal.created_by,
    );
    setShowEvalModal(false);
    await loadEvaluations();
    onEvaluationAdded();
  };

  const handleEditEval = async (score: number, notes: string, statusAfter: GoalStatus) => {
    if (!editingEval) return;
    await FirestoreService.updateGoalEvaluation(
      contactId,
      goal.id,
      editingEval.id,
      {
        score,
        notes: notes || null,
        status_after: statusAfter,
      },
      goal.created_by,
    );
    setEditingEval(null);
    await loadEvaluations();
    onEvaluationAdded();
  };

  const canEvaluate = goal.status === 'open' || goal.status === 'in_progress';
  const statusColor = STATUS_COLORS[goal.status];

  return (
    <>
      <Card
        style={{ marginBottom: 12, borderRadius: 12, overflow: 'hidden' }}
        elevation={1}
      >
        <View style={{ padding: 14 }}>
          {/* Header row: title + action icons */}
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <View style={{ flex: 1 }}>
              <Text variant="titleMedium" style={{ fontWeight: '700', color: theme.colors.onSurface }}>
                {goal.title}
              </Text>
              {goal.description ? (
                <Text
                  variant="bodySmall"
                  style={{ color: theme.colors.onSurfaceVariant, marginTop: 2 }}
                  numberOfLines={expanded ? undefined : 2}
                >
                  {goal.description}
                </Text>
              ) : null}
            </View>
            {goal.created_by === 'coach' ? (
              <TouchableRipple
                onPress={() => Alert.alert(t('coachGoalTitle'), t('coachGoalBody'))}
                borderless
                style={{ borderRadius: 16, padding: 4 }}
              >
                <Icon source="information-outline" size={22} color={theme.colors.primary} />
              </TouchableRipple>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
                {onEditGoal && (
                  <TouchableRipple
                    onPress={onEditGoal}
                    borderless
                    style={{ borderRadius: 16, padding: 4 }}
                  >
                    <Icon source="pencil-outline" size={22} color={theme.colors.onSurfaceVariant} />
                  </TouchableRipple>
                )}
                {onDeleteGoal && (
                  <TouchableRipple
                    onPress={onDeleteGoal}
                    borderless
                    style={{ borderRadius: 16, padding: 4 }}
                  >
                    <Icon source="delete-outline" size={22} color={theme.colors.error} />
                  </TouchableRipple>
                )}
              </View>
            )}
          </View>

          {/* Badges row */}
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
            <Chip
              compact
              style={{ backgroundColor: statusColor + '20', height: 24 }}
              textStyle={{ color: statusColor, fontSize: 11, fontWeight: '700', marginVertical: 0 }}
            >
              {statusLabel(t, goal.status)}
            </Chip>
            {(goal.categories ?? []).map(cat => (
              <Chip
                key={cat}
                compact
                style={{ backgroundColor: theme.colors.surfaceVariant, height: 24 }}
                textStyle={{ fontSize: 11, marginVertical: 0 }}
              >
                {goalCategoryLabel(cat, categoryOptions)}
              </Chip>
            ))}
            {/* Provenance, not a category — drawn as an outline so the two
                never read as one list. */}
            {goal.from_dimension ? (
              <Chip
                compact
                mode="outlined"
                style={{ backgroundColor: 'transparent', height: 24 }}
                textStyle={{ fontSize: 11, marginVertical: 0, color: theme.colors.onSurfaceVariant }}
              >
                {t('fromPrefix', { dimension: dimensionLabel(goal.from_dimension, dimensionOptions) })}
              </Chip>
            ) : null}
            {goal.target_date ? (
              <Chip
                compact
                style={{ backgroundColor: theme.colors.surfaceVariant, height: 24 }}
                textStyle={{ fontSize: 11, marginVertical: 0 }}
              >
                {t('targetPrefix', { date: formatGoalDate(goal.target_date) })}
              </Chip>
            ) : null}
          </View>

          {/* Steps (tasks) nested under this goal */}
          {steps.length > 0 && (
            <View style={{ marginTop: 10 }}>
              {steps.map(step => (
                <TaskRow key={step.id} task={step} contactId={contactId} onChanged={onEvaluationAdded} nested />
              ))}
            </View>
          )}

          {/* Expand/collapse footer */}
          <TouchableRipple onPress={handleExpand} borderless style={{ borderRadius: 8, marginTop: 8, alignSelf: 'flex-end' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2, paddingVertical: 2, paddingHorizontal: 4 }}>
              <Text variant="labelSmall" style={{ color: theme.colors.onSurfaceVariant }}>
                {expanded ? t('hide') : t('evaluationsLabel')}
              </Text>
              <Icon
                source={expanded ? 'chevron-up' : 'chevron-down'}
                size={16}
                color={theme.colors.onSurfaceVariant}
              />
            </View>
          </TouchableRipple>
        </View>

        {/* Expanded section */}
        {expanded && (
          <View style={{ paddingHorizontal: 14, paddingBottom: 14 }}>
            <View
              style={{
                height: 1,
                backgroundColor: theme.colors.outlineVariant,
                marginBottom: 12,
              }}
            />

            {loadingEvals ? (
              <ActivityIndicator size="small" style={{ marginVertical: 8 }} />
            ) : evaluations.length === 0 ? (
              <Text variant="bodySmall" style={{ color: theme.colors.onSurfaceVariant, marginBottom: 8 }}>
                {t('noEvaluationsYet')}
              </Text>
            ) : (
              evaluations.map(ev => (
                <EvaluationItem
                  key={ev.id}
                  eval_={ev}
                  onEdit={ev.evaluated_by === 'student' ? () => setEditingEval(ev) : undefined}
                />
              ))
            )}

            {canEvaluate && (
              <Button
                mode="outlined"
                icon="plus"
                onPress={() => setShowEvalModal(true)}
                style={{ alignSelf: 'flex-start', marginTop: 4 }}
                compact
              >
                {t('addEvaluationTitle')}
              </Button>
            )}
          </View>
        )}
      </Card>

      <AddEvalModal
        visible={showEvalModal}
        currentStatus={goal.status}
        allowStatusChange={allowStatusChange}
        onDismiss={() => setShowEvalModal(false)}
        onSubmit={handleAddEval}
      />

      <AddEvalModal
        visible={editingEval !== null}
        currentStatus={goal.status}
        allowStatusChange={allowStatusChange}
        initialScore={editingEval?.score}
        initialNotes={editingEval?.notes}
        initialStatusAfter={editingEval?.status_after}
        onDismiss={() => setEditingEval(null)}
        onSubmit={handleEditEval}
      />
    </>
  );
};

// ─── GoalsSection ─────────────────────────────────────────────────────────────

export const GoalsSection: React.FC<Props> = ({ contactId, teamId }) => {
  const theme = useTheme();
  const t = useTranslations('Goals');
  const [goals, setGoals] = useState<Goal[]>([]);
  const [categoryOptions, setCategoryOptions] = useState<PerformanceIndicator[]>([]);
  const [dimensionOptions, setDimensionOptions] = useState<PerformanceIndicator[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingGoal, setEditingGoal] = useState<Goal | null>(null);

  const loadGoals = useCallback(async () => {
    setLoading(true);
    try {
      const [data, cats, dims] = await Promise.all([
        FirestoreService.getGoals(contactId),
        teamId ? FirestoreService.getGoalCategories(teamId) : Promise.resolve([]),
        teamId ? FirestoreService.getCoachingDimensions(teamId) : Promise.resolve([]),
      ]);
      setGoals(data);
      setCategoryOptions(cats);
      setDimensionOptions(dims);
    } finally {
      setLoading(false);
    }
  }, [contactId, teamId]);

  useEffect(() => {
    loadGoals();
  }, [loadGoals]);

  const handleAddGoal = async (
    title: string,
    description: string,
    categories: string[],
    targetDate: Date | null,
  ) => {
    await FirestoreService.createGoal(contactId, {
      type: 'goal',
      title,
      description: description || null,
      status: 'open',
      categories,
      created_by: 'student',
      created_at: Timestamp.now(),
      target_date: targetDate ? Timestamp.fromDate(targetDate) : null,
      parent_goal_id: null,
    });
    setShowAddModal(false);
    await loadGoals();
  };

  const handleEditGoal = async (
    title: string,
    description: string,
    categories: string[],
    targetDate: Date | null,
  ) => {
    if (!editingGoal) return;
    await FirestoreService.updateGoal(contactId, editingGoal.id, {
      title,
      description: description || null,
      categories,
      target_date: targetDate ? Timestamp.fromDate(targetDate) : null,
    });
    setEditingGoal(null);
    await loadGoals();
  };

  const handleDeleteGoal = (goal: Goal) => {
    Alert.alert(
      t('deleteGoalTitle'),
      t('deleteGoalConfirm', { title: goal.title }),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('delete'),
          style: 'destructive',
          onPress: async () => {
            await FirestoreService.deleteGoal(contactId, goal.id);
            await loadGoals();
          },
        },
      ],
    );
  };

  // Sort AROUND the grouping helper, never inside it — its contract is to
  // preserve input order, and the query hands it created_at-desc. Without this
  // a goal's steps read as their sequence in REVERSE. The web fixed exactly
  // this (see sortSteps' header) and called it fixed on "both surfaces"; the
  // app was a third surface running the same query.
  const grouped = groupGoalsWithSteps(goals);
  const goalGroups = grouped.goals.map(g => ({ ...g, steps: sortSteps(g.steps, 'manual') }));
  const generalSteps = sortSteps(grouped.generalSteps, 'manual');
  const isEmpty = goalGroups.length === 0 && generalSteps.length === 0;

  return (
    <View style={{ marginBottom: 16 }}>
      {/* Section heading — outside cards */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingHorizontal: 4 }}>
        <Text variant="titleLarge" style={{ fontWeight: '800', color: theme.colors.onSurface }}>
          {t('goalsHeading')}
        </Text>
        <Button mode="contained-tonal" icon="plus" compact onPress={() => setShowAddModal(true)}>
          {t('addGoalTitle')}
        </Button>
      </View>

      {loading ? (
        <ActivityIndicator size="small" style={{ marginVertical: 24 }} />
      ) : isEmpty ? (
        <View style={{ alignItems: 'center', paddingVertical: 24, gap: 8 }}>
          <Icon source="flag-outline" size={40} color={theme.colors.onSurfaceVariant} />
          <Text variant="bodyMedium" style={{ color: theme.colors.onSurfaceVariant, textAlign: 'center' }}>
            {t('emptyStateNoGoals')}
          </Text>
        </View>
      ) : (
        <>
          {goalGroups.map(({ goal, steps }) => (
            <GoalCard
              key={goal.id}
              goal={goal}
              steps={steps}
              contactId={contactId}
              categoryOptions={categoryOptions}
              dimensionOptions={dimensionOptions}
              onEvaluationAdded={loadGoals}
              onEditGoal={goal.created_by === 'student' ? () => setEditingGoal(goal) : undefined}
              onDeleteGoal={goal.created_by === 'student' ? () => handleDeleteGoal(goal) : undefined}
            />
          ))}

          {generalSteps.length > 0 && (
            <View style={{ marginTop: goalGroups.length > 0 ? 4 : 0 }}>
              <Text
                variant="titleSmall"
                style={{ fontWeight: '700', color: theme.colors.onSurfaceVariant, marginBottom: 8, paddingHorizontal: 4 }}
              >
                {t('generalLabel')}
              </Text>
              {generalSteps.map(step => (
                <TaskRow key={step.id} task={step} contactId={contactId} onChanged={loadGoals} />
              ))}
            </View>
          )}
        </>
      )}

      <AddGoalModal
        visible={showAddModal}
        categoryOptions={categoryOptions}
        onDismiss={() => setShowAddModal(false)}
        onSubmit={handleAddGoal}
      />

      <AddGoalModal
        visible={editingGoal !== null}
        categoryOptions={categoryOptions}
        initialTitle={editingGoal?.title}
        initialDescription={editingGoal?.description}
        initialCategories={editingGoal?.categories}
        initialTargetDate={editingGoal?.target_date ? editingGoal.target_date.toDate() : null}
        onDismiss={() => setEditingGoal(null)}
        onSubmit={handleEditGoal}
      />
    </View>
  );
};
