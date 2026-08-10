import { ActivityLog } from '../schemas/activity-logs';

export const ACTIVITY_ACTIONS = {
  CATEGORY_CREATE: 'Created category',
  CATEGORY_EDIT: 'Edited category',
  CATEGORY_GROUP_CREATE: 'Created category group',
  CATEGORY_GROUP_EDIT: 'Edited category group',
  CATEGORY_GROUP_DELETE: 'Deleted category group',
  WELCOME_MESSAGE_EDIT: 'Edited welcome message',
  USER_ROLE_CHANGE: 'Changed user role',
  USER_ACTIVATE: 'Activated user',
  USER_DEACTIVATE: 'Deactivated user',
  USER_PASSWORD_RESET: 'Sent password reset',
  USER_BAN: 'Banned user',
  USER_UNBAN: 'Unbanned user',
  USER_SIGNATURE_DELETE: 'Deleted user signature',
  USER_BIO_DELETE: 'Deleted user bio',
  THREAD_LOCK: 'Locked thread',
  THREAD_UNLOCK: 'Unlocked thread',
  POST_EDIT: 'Edited post (moderator override)',
  POST_DELETE: 'Deleted post',
} as const;

export interface ActivityActor {
  userId: string;
  username: string;
  role: 'moderator' | 'admin';
}

export const actorFrom = (user: {
  userId: string;
  username: string;
  isAdmin: boolean;
}): ActivityActor => ({
  userId: user.userId,
  username: user.username,
  role: user.isAdmin ? 'admin' : 'moderator',
});

export const logActivity = async (
  actor: ActivityActor,
  action: string,
  target: { id: string; label: string } | null = null,
  details = '',
): Promise<void> => {
  await ActivityLog.create({
    actor: actor.userId,
    actorUsername: actor.username,
    actorRole: actor.role,
    action,
    targetId: target?.id ?? null,
    targetLabel: target?.label ?? '',
    details,
  });
};
