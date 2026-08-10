import { User } from '../schemas/users';

interface IPBanInfo {
  reason: string;
  bannedUntil: Date | null;
}

const bannedIPs = new Map<string, IPBanInfo>();

export const loadBannedIPs = async (): Promise<void> => {
  const now = new Date();
  const users = await User.find(
    { banIP: { $ne: null }, bannedUntil: { $gt: now } },
    'banIP banReason bannedUntil',
  ).lean();

  bannedIPs.clear();
  for (const user of users) {
    if (user.banIP) {
      bannedIPs.set(user.banIP, {
        reason: user.banReason ?? '',
        bannedUntil: user.bannedUntil ? new Date(user.bannedUntil) : null,
      });
    }
  }
};

export const setIPBan = (
  ip: string,
  reason: string,
  bannedUntil: Date | null,
): void => {
  bannedIPs.set(ip, { reason, bannedUntil });
};

export const clearIPBan = (ip: string): void => {
  bannedIPs.delete(ip);
};

export const getIPBan = (ip: string): IPBanInfo | null =>
  bannedIPs.get(ip) ?? null;
