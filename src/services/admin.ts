import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { Category } from '../schemas/categories';
import { CategoryGroup } from '../schemas/category-groups';
import { User } from '../schemas/users';
import { BanLog } from '../schemas/ban-logs';
import { ActivityLog } from '../schemas/activity-logs';
import { EXTENSIONS_BY_MIMETYPE } from './avatar';
import { resizeLogo } from './images';
import { UNGROUPED_BOX_NAME } from './forum';
import { generateResetToken, RESET_TOKEN_TTL_MS } from './password-reset';
import { ViewConfig } from '../views';
import { actorFrom, logActivity, ACTIVITY_ACTIONS } from './activity-log';

const CATEGORY_LOGOS_DIR = join(__dirname, '..', 'public', 'categories');

const USER_ROLES = ['user', 'moderator', 'admin'] as const;

const ACTIVITY_LOGS_PER_PAGE = 50;

const currentPage = (query: { page?: string }): number => {
  const parsed = parseInt(query.page || '1', 10);
  return Number.isNaN(parsed) ? 1 : Math.max(1, parsed);
};

const FIELD_NAME_PATTERN = /^(\w+)\[(.+)\]$/;

// i hate flattening
const sortCategoriesForAdmin = <
  T extends {
    _id: { toString(): string };
    parent?: { toString(): string } | null;
    name: string;
    order: number;
  },
>(
  categories: T[],
): (T & { depth: number })[] => {
  const byParent = new Map<string, T[]>();
  for (const cat of categories) {
    const key = cat.parent ? cat.parent.toString() : '';
    const siblings = byParent.get(key) ?? [];
    siblings.push(cat);
    byParent.set(key, siblings);
  }
  for (const siblings of byParent.values()) {
    siblings.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  }

  const out: (T & { depth: number })[] = [];
  const visited = new Set<string>();
  const visit = (parentKey: string, depth: number) => {
    for (const cat of byParent.get(parentKey) ?? []) {
      const id = cat._id.toString();
      if (visited.has(id)) continue; // guards against a parent cycle i hope
      visited.add(id);
      out.push({ ...cat, depth });
      visit(id, depth + 1);
    }
  };
  visit('', 0);

  for (const cat of categories) {
    if (!visited.has(cat._id.toString())) {
      out.push({ ...cat, depth: 0 });
    }
  }

  return out;
};

const indexFields = (
  fields: Record<string, string>,
): Record<string, Record<string, string>> => {
  const out: Record<string, Record<string, string>> = {};
  for (const [key, value] of Object.entries(fields)) {
    const match = FIELD_NAME_PATTERN.exec(key);
    if (!match) continue;
    (out[match[1]] ??= {})[match[2]] = value;
  }
  return out;
};

const wouldCreateLoop = (
  catId: string,
  parentId: string,
  parentsById: Map<string, string | null>,
): boolean => {
  let current: string | null = parentId;
  const seen = new Set<string>();
  while (current) {
    if (current === catId || seen.has(current)) return true;
    seen.add(current);
    current = parentsById.get(current) ?? null;
  }
  return false;
};

export const admin = async (
  app: FastifyInstance,
  config: ViewConfig,
  sendPasswordResetEmail: (
    to: string,
    token: string,
    baseUrl: string,
  ) => Promise<void>,
) => {
  const requireAdmin = (reply: FastifyReply) => {
    if (!reply.locals || !reply.locals.user) {
      reply.redirect('/login');
      return null;
    }
    if (!reply.locals.user.isAdmin) {
      reply.redirect('/');
      return null;
    }
    return reply.locals.user;
  };

  const renderCategories = async (
    reply: FastifyReply,
    feedback: { error?: string; message?: string } = {},
  ) => {
    const [categories, groups] = await Promise.all([
      Category.find().sort({ order: 1, name: 1 }).lean(),
      CategoryGroup.find().sort({ order: 1, name: 1 }).lean(),
    ]);
    return reply.view('admin-categories', {
      ...config,
      user: reply.locals!.user,
      categories: sortCategoriesForAdmin(categories),
      groups,
      UNGROUPED_BOX_NAME,
      ...feedback,
    });
  };

  const renderUsers = async (
    reply: FastifyReply,
    feedback: { error?: string; message?: string } = {},
  ) =>
    reply.view('admin-users', {
      ...config,
      user: reply.locals!.user,
      users: await User.find().sort('username').lean(),
      ...feedback,
    });

  const renderBanLog = async (
    reply: FastifyReply,
    feedback: { error?: string; message?: string } = {},
  ) => {
    const entries = await BanLog.find()
      .sort('-createdAt')
      .populate('user', 'username')
      .populate('bannedBy', 'username')
      .lean();

    return reply.view('admin-ban-log', {
      ...config,
      user: reply.locals!.user,
      entries: entries.map((entry) => ({
        _id: entry._id,
        user: entry.user as unknown as { _id: string; username: string } | null,
        bannedBy: entry.bannedBy as unknown as {
          _id: string;
          username: string;
        } | null,
        reason: entry.reason,
        bannedUntil: entry.bannedUntil ? new Date(entry.bannedUntil) : null,
        ip: entry.ip,
        active: entry.active,
        unbannedAt: entry.unbannedAt ? new Date(entry.unbannedAt) : null,
      })),
      ...feedback,
    });
  };

  const renderActivityLog = async (reply: FastifyReply, page: number) => {
    const logCount = await ActivityLog.countDocuments();
    const totalPages = Math.max(
      1,
      Math.ceil(logCount / ACTIVITY_LOGS_PER_PAGE),
    );
    const clampedPage = Math.min(totalPages, page);
    const skip = (clampedPage - 1) * ACTIVITY_LOGS_PER_PAGE;

    const logs = await ActivityLog.find()
      .sort('-createdAt')
      .skip(skip)
      .limit(ACTIVITY_LOGS_PER_PAGE)
      .lean();

    return reply.view('admin-activity-log', {
      ...config,
      user: reply.locals!.user,
      logs,
      page: clampedPage,
      totalPages,
      basePath: '/admin/activity-log',
    });
  };

  app.get('/admin', async (_, reply) => {
    return reply.redirect('/admin/categories');
  });

  app.get('/admin/categories', async (_, reply) => {
    if (!requireAdmin(reply)) return;
    return renderCategories(reply);
  });

  app.post('/admin/categories', async (request, reply) => {
    const adminUser = requireAdmin(reply);
    if (!adminUser) return;

    const fields: Record<string, string> = {};
    const files: Record<string, { buffer: Buffer; mimetype: string }> = {};
    for await (const part of request.parts()) {
      if (part.type === 'file') {
        try {
          const buffer = await part.toBuffer();
          if (part.filename) {
            files[part.fieldname] = { buffer, mimetype: part.mimetype };
          }
        } catch {
          return renderCategories(reply, {
            error: 'Logo is too large (10MB max)',
          });
        }
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }

    const grouped = indexFields(fields);
    const categories = await Category.find();
    const parentsById = new Map(
      categories.map((cat) => [
        cat._id.toString(),
        cat.parent ? cat.parent.toString() : null,
      ]),
    );
    const validGroupIds = new Set(
      (await CategoryGroup.find().select('_id').lean()).map((g) =>
        g._id.toString(),
      ),
    );

    const errors: string[] = [];

    const saveLogo = async (
      logo: { buffer: Buffer; mimetype: string },
      base: string,
    ): Promise<string | null> => {
      if (!EXTENSIONS_BY_MIMETYPE[logo.mimetype]) return null;
      let resized: Buffer;
      try {
        resized = await resizeLogo(logo.buffer);
      } catch {
        return null;
      }
      const filename = `${base}.gif`;
      await writeFile(join(CATEGORY_LOGOS_DIR, filename), resized);
      return filename;
    };

    // diff every row against the database and apply what changed
    for (const cat of categories) {
      const id = cat._id.toString();
      const changedFields: string[] = [];

      const name = grouped.name?.[id]?.trim();
      if (name && name !== cat.name) {
        changedFields.push('name');
        cat.name = name;
      }

      const description = grouped.description?.[id];
      if (description !== undefined && description !== cat.description) {
        changedFields.push('description');
        cat.description = description;
      }

      const orderValue = grouped.order?.[id];
      if (orderValue !== undefined) {
        const order = parseInt(orderValue, 10);
        if (!Number.isNaN(order) && order !== cat.order) {
          changedFields.push('order');
          cat.order = order;
        }
      }

      const oldParent = cat.parent ? cat.parent.toString() : null;
      const parentSubmitted = grouped.parent !== undefined && id in grouped.parent;
      const newParent = parentSubmitted ? grouped.parent[id] || null : oldParent;

      const groupSubmitted = grouped.group !== undefined && id in grouped.group;
      const groupValue = groupSubmitted ? grouped.group[id] || null : null;

      if (newParent && groupValue) {
        errors.push(`"${cat.name}" cannot have both a parent and a group`);
      } else {
        if (newParent !== oldParent) {
          if (newParent && wouldCreateLoop(id, newParent, parentsById)) {
            errors.push(
              `"${cat.name}" cannot have "${parentsById.has(newParent) ? categories.find((c) => c._id.toString() === newParent)?.name : newParent}" as parent: it would create a loop`,
            );
          } else {
            changedFields.push('parent');
            cat.parent = newParent as never;
            parentsById.set(id, newParent);
          }
        }

        if (groupSubmitted) {
          const oldGroup = cat.group ? cat.group.toString() : null;
          if (groupValue !== oldGroup) {
            if (groupValue && !validGroupIds.has(groupValue)) {
              errors.push(`"${cat.name}" was assigned an unknown group`);
            } else {
              changedFields.push('group');
              cat.group = groupValue as never;
            }
          }
        }
      }

      const logo = files[`logo[${id}]`];
      if (logo) {
        const filename = await saveLogo(logo, id);
        if (filename) {
          if (cat.logo && cat.logo !== filename) {
            await unlink(join(CATEGORY_LOGOS_DIR, cat.logo)).catch(() => {});
          }
          changedFields.push('logo');
          cat.logo = filename;
        } else {
          errors.push(
            `Logo for "${cat.name}" must be a readable PNG, JPEG, GIF or WebP image`,
          );
        }
      } else if (grouped.removeLogo?.[id] && cat.logo) {
        await unlink(join(CATEGORY_LOGOS_DIR, cat.logo)).catch(() => {});
        changedFields.push('logo');
        cat.logo = '';
      }

      if (cat.isModified()) {
        try {
          await cat.save();
          await logActivity(
            actorFrom(adminUser),
            ACTIVITY_ACTIONS.CATEGORY_EDIT,
            { id, label: cat.name },
            changedFields.join(', '),
          );
        } catch (err) {
          if ((err as { code?: number }).code === 11000) {
            errors.push(
              `A category named "${cat.name}" already exists under the same parent`,
            );
          } else {
            throw err;
          }
        }
      }
    }

    if (fields.newName?.trim()) {
      const newParent = fields.newParent || null;
      const newGroup = fields.newGroup || null;

      if (newParent && newGroup) {
        errors.push('New category cannot have both a parent and a group');
      } else {
        if (newGroup && !validGroupIds.has(newGroup)) {
          errors.push('New category was assigned an unknown group');
        }
        const newCat = new Category({
          name: fields.newName.trim(),
          description: fields.newDescription ?? '',
          parent: newParent,
          group: newGroup && validGroupIds.has(newGroup) ? newGroup : null,
        });
        if (files.newLogo) {
          const filename = await saveLogo(files.newLogo, newCat._id.toString());
          if (filename) newCat.logo = filename;
          else
            errors.push(
              'New category logo must be a readable PNG, JPEG, GIF or WebP image',
            );
        }
        try {
          await newCat.save();
          await logActivity(
            actorFrom(adminUser),
            ACTIVITY_ACTIONS.CATEGORY_CREATE,
            { id: newCat._id.toString(), label: newCat.name },
          );
        } catch (err) {
          if ((err as { code?: number }).code === 11000) {
            errors.push(
              `A category named "${newCat.name}" already exists under the same parent`,
            );
          } else {
            throw err;
          }
        }
      }
    }

    if (errors.length > 0) {
      return renderCategories(reply, { error: errors.join(' ') });
    }
    return renderCategories(reply, { message: 'Categories saved' });
  });

  app.post('/admin/category-groups', async (request, reply) => {
    const adminUser = requireAdmin(reply);
    if (!adminUser) return;

    const fields = request.body as Record<string, string>;
    const grouped = indexFields(fields);
    const groups = await CategoryGroup.find();

    const errors: string[] = [];

    for (const group of groups) {
      const id = group._id.toString();
      const changedFields: string[] = [];

      if (grouped.delete?.[id]) {
        await Category.updateMany({ group: group._id }, { group: null });
        await group.deleteOne();
        await logActivity(
          actorFrom(adminUser),
          ACTIVITY_ACTIONS.CATEGORY_GROUP_DELETE,
          { id, label: group.name },
        );
        continue;
      }

      const name = grouped.name?.[id]?.trim();
      if (name && name !== group.name) {
        changedFields.push('name');
        group.name = name;
      }

      const orderValue = grouped.order?.[id];
      if (orderValue !== undefined) {
        const order = parseInt(orderValue, 10);
        if (!Number.isNaN(order) && order !== group.order) {
          changedFields.push('order');
          group.order = order;
        }
      }

      if (group.isModified()) {
        try {
          await group.save();
          await logActivity(
            actorFrom(adminUser),
            ACTIVITY_ACTIONS.CATEGORY_GROUP_EDIT,
            { id, label: group.name },
            changedFields.join(', '),
          );
        } catch (err) {
          if ((err as { code?: number }).code === 11000) {
            errors.push(`A category group named "${group.name}" already exists`);
          } else {
            throw err;
          }
        }
      }
    }

    if (fields.newGroupName?.trim()) {
      const newGroup = new CategoryGroup({ name: fields.newGroupName.trim() });
      try {
        await newGroup.save();
        await logActivity(
          actorFrom(adminUser),
          ACTIVITY_ACTIONS.CATEGORY_GROUP_CREATE,
          { id: newGroup._id.toString(), label: newGroup.name },
        );
      } catch (err) {
        if ((err as { code?: number }).code === 11000) {
          errors.push(`A category group named "${newGroup.name}" already exists`);
        } else {
          throw err;
        }
      }
    }

    if (errors.length > 0) {
      return renderCategories(reply, { error: errors.join(' ') });
    }
    return renderCategories(reply, { message: 'Category groups saved' });
  });

  app.get('/admin/users', async (_, reply) => {
    if (!requireAdmin(reply)) return;
    return renderUsers(reply);
  });

  app.get('/admin/ban-log', async (_, reply) => {
    if (!requireAdmin(reply)) return;
    return renderBanLog(reply);
  });

  app.get('/admin/activity-log', async (request, reply) => {
    if (!requireAdmin(reply)) return;
    return renderActivityLog(
      reply,
      currentPage(request.query as { page?: string }),
    );
  });

  app.post('/admin/users', async (request, reply) => {
    const adminUser = requireAdmin(reply);
    if (!adminUser) return;

    const grouped = indexFields((request.body ?? {}) as Record<string, string>);
    const active = grouped.active ?? {};
    const roles = grouped.role ?? {};

    const users = await User.find();
    for (const user of users) {
      const id = user._id.toString();
      const isSelf = id === adminUser.userId;
      const oldRole = user.role;
      const oldActive = user.isActive;

      const shouldBeActive = active[id] === 'on';
      if (shouldBeActive !== user.isActive) {
        if (!isSelf || shouldBeActive) {
          user.isActive = shouldBeActive;
        }
      }

      const newRole = roles[id];
      if (newRole && newRole !== user.role) {
        if (!USER_ROLES.includes(newRole as (typeof USER_ROLES)[number])) {
          return renderUsers(reply, { error: `Unknown role "${newRole}"` });
        }
        if (!isSelf || newRole === 'admin') {
          user.role = newRole as typeof user.role;
        }
      }

      if (user.isModified()) {
        await user.save();

        if (user.role !== oldRole) {
          await logActivity(
            actorFrom(adminUser),
            ACTIVITY_ACTIONS.USER_ROLE_CHANGE,
            { id, label: user.username },
            `${oldRole} → ${user.role}`,
          );
        }
        if (user.isActive !== oldActive) {
          await logActivity(
            actorFrom(adminUser),
            user.isActive
              ? ACTIVITY_ACTIONS.USER_ACTIVATE
              : ACTIVITY_ACTIONS.USER_DEACTIVATE,
            { id, label: user.username },
          );
        }
      }
    }

    return renderUsers(reply, { message: 'Users saved' });
  });

  app.post('/admin/users/:id/reset-password', async (request, reply) => {
    const adminUser = requireAdmin(reply);
    if (!adminUser) return;

    const { id } = request.params as { id: string };
    const user = await User.findById(id);
    if (!user) {
      return renderUsers(reply, { error: 'User not found' });
    }

    user.passwordResetToken = generateResetToken();
    user.passwordResetExpires = new Date(Date.now() + RESET_TOKEN_TTL_MS);

    try {
      await sendPasswordResetEmail(
        user.email,
        user.passwordResetToken,
        config.boardBaseURL,
      );
    } catch (err) {
      request.log.warn(
        { err, email: user.email },
        'Failed to send admin-triggered password reset email',
      );
      return renderUsers(reply, {
        error: `Could not send the reset email to ${user.email}`,
      });
    }

    user.isActive = false;
    await user.save();

    await logActivity(
      actorFrom(adminUser),
      ACTIVITY_ACTIONS.USER_PASSWORD_RESET,
      { id, label: user.username },
      `Reset email sent to ${user.email}`,
    );

    return renderUsers(reply, {
      message: `Reset email sent to ${user.email}; their account is disabled until they set a new password.`,
    });
  });
};
