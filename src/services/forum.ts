import type { FastifyInstance } from 'fastify';
import { isValidObjectId, type Types } from 'mongoose';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Category } from '../schemas/categories';
import { CategoryGroup } from '../schemas/category-groups';
import { Thread } from '../schemas/threads';
import { Post } from '../schemas/posts';
import { ViewConfig } from '../views';
import { renderPost, renderSignature, type PostProcessor } from './formatting';
import { avatarUrlFor } from './auth';
import { actorFrom, logActivity, ACTIVITY_ACTIONS } from './activity-log';

const CATEGORY_LOGOS_DIR = join(__dirname, '..', 'public', 'categories');

const THREADS_PER_PAGE = 10;
const POSTS_PER_PAGE = 10;

const ROLE_ICONS: Record<string, string> = {
  admin: 'administration-24.png',
  moderator: 'gnome-eyes-24.png',
  user: 'music-player-24.png',
};

const currentPage = (query: { page?: string }): number => {
  const parsed = parseInt(query.page || '1', 10);
  return Number.isNaN(parsed) ? 1 : Math.max(1, parsed);
};

interface CategoryDoc {
  _id: Types.ObjectId;
  name: string;
  description: string;
  logo: string;
}

interface ThreadDoc {
  _id: Types.ObjectId;
  title: string;
  author: Types.ObjectId;
  category: Types.ObjectId;
  content: string;
  lastPost: Types.ObjectId | null;
  locked: boolean;
  createdAt: Date;
}

export interface LastThread {
  _id: Types.ObjectId;
  title: string;
  locked: boolean;
  authorId: Types.ObjectId | null;
  authorName: string;
  createdAt: Date;
}

export interface LastPostLink {
  _id: Types.ObjectId;
  threadId: Types.ObjectId;
  page: number;
  title: string;
  locked: boolean;
  authorId: Types.ObjectId | null;
  authorName: string;
  createdAt: Date;
}

export interface CategoryItem {
  category: CategoryDoc;
  children: CategoryDoc[];
  threadCount: number;
  postCount: number;
  lastPost: LastPostLink | null;
}

interface PopulatedAuthor {
  _id: Types.ObjectId;
  username: string;
  avatar: string;
  role: string;
  signature: string;
  signatureProcessor: string;
}

interface PopulatedPost {
  _id: Types.ObjectId;
  thread: Types.ObjectId;
  author: PopulatedAuthor | null;
  createdAt: Date;
}

const createThreadBodySchema = z.object({
  title: z.string().trim().min(1, 'Title is required'),
  content: z.string().min(1, 'Post content is required'),
  processor: z.enum(['bbcode', 'markdown']).default('bbcode'),
});

const replyBodySchema = z.object({
  content: z.string().min(1, 'Post content is required'),
  processor: z.enum(['bbcode', 'markdown']).default('bbcode'),
});

const editPostBodySchema = z.object({
  content: z.string().min(1, 'Post content is required'),
  processor: z.enum(['bbcode', 'markdown']).default('bbcode'),
});

const updateThreadLastPost = async (threadId: Types.ObjectId) => {
  const lastPost = await Post.findOne({ thread: threadId })
    .sort('-createdAt')
    .select('_id')
    .lean();
  await Thread.findByIdAndUpdate(threadId, {
    lastPost: lastPost ? lastPost._id : null,
  });
};

const lastPageForThread = async (threadId: Types.ObjectId): Promise<number> => {
  const count = await Post.countDocuments({ thread: threadId });
  return Math.max(1, Math.ceil(count / POSTS_PER_PAGE));
};

export const pageForPost = async (post: {
  thread: Types.ObjectId;
  createdAt: Date;
}): Promise<number> => {
  const before = await Post.countDocuments({
    thread: post.thread,
    createdAt: { $lt: post.createdAt },
  });
  const position = before + 1;
  return Math.max(1, Math.ceil(position / POSTS_PER_PAGE));
};

const withExistingLogo = <T extends CategoryDoc>(category: T): T => ({
  ...category,
  logo:
    category.logo && existsSync(join(CATEGORY_LOGOS_DIR, category.logo))
      ? category.logo
      : '',
});

export const buildCategoryItems = async (
  categories: CategoryDoc[],
): Promise<CategoryItem[]> =>
  Promise.all(
    categories.map(async (category) => {
      const [children, threadCount, threads] = await Promise.all([
        Category.find({ parent: category._id })
          .sort({ order: 1, name: 1 })
          .lean<CategoryDoc[]>(),
        Thread.countDocuments({ category: category._id }),
        Thread.find({ category: category._id })
          .select('_id')
          .lean<{ _id: Types.ObjectId }[]>(),
      ]);

      const postCount =
        threads.length > 0
          ? await Post.countDocuments({
              thread: { $in: threads.map((thread) => thread._id) },
            })
          : 0;

      const lastPost =
        threads.length > 0
          ? await Post.findOne({
              thread: { $in: threads.map((thread) => thread._id) },
            })
              .sort('-createdAt')
              .populate<{ author: PopulatedAuthor }>('author', 'username')
              .populate<{
                thread: { _id: Types.ObjectId; title: string; locked: boolean };
              }>('thread', 'title locked')
              .lean()
          : null;

      return {
        category: withExistingLogo(category),
        children: children.map(withExistingLogo),
        threadCount,
        postCount,
        lastPost: lastPost
          ? {
              _id: lastPost._id,
              threadId: lastPost.thread._id,
              page: await pageForPost({
                thread: lastPost.thread._id,
                createdAt: lastPost.createdAt,
              }),
              title: lastPost.thread.title,
              locked: lastPost.thread.locked ?? false,
              authorId: lastPost.author?._id ?? null,
              authorName: lastPost.author?.username ?? 'unknown',
              createdAt: lastPost.createdAt,
            }
          : null,
      };
    }),
  );

export interface CategoryBox {
  name: string;
  items: CategoryItem[];
}

export const UNGROUPED_BOX_NAME = 'Forums';

export const buildCategoryBoxes = async (): Promise<CategoryBox[]> => {
  const [groups, roots] = await Promise.all([
    CategoryGroup.find().sort({ order: 1, name: 1 }).lean(),
    Category.find({ parent: null })
      .sort({ order: 1, name: 1 })
      .lean<(CategoryDoc & { group: Types.ObjectId | null })[]>(),
  ]);

  const rootsByGroup = new Map<string, typeof roots>();
  for (const root of roots) {
    const key = root.group ? root.group.toString() : '';
    const bucket = rootsByGroup.get(key) ?? [];
    bucket.push(root);
    rootsByGroup.set(key, bucket);
  }

  const orderedBuckets = [
    { name: UNGROUPED_BOX_NAME, roots: rootsByGroup.get('') ?? [] },
    ...groups.map((group) => ({
      name: group.name,
      roots: rootsByGroup.get(group._id.toString()) ?? [],
    })),
  ].filter((bucket) => bucket.roots.length > 0);

  return Promise.all(
    orderedBuckets.map(async (bucket) => ({
      name: bucket.name,
      items: await buildCategoryItems(bucket.roots),
    })),
  );
};

const fetchLastPosts = async (
  threadIds: Types.ObjectId[],
): Promise<Map<string, PopulatedPost>> => {
  const posts = await Post.find({ thread: { $in: threadIds } })
    .sort('-createdAt')
    .populate<{ author: PopulatedAuthor }>('author', 'username')
    .lean();

  const map = new Map<string, PopulatedPost>();
  for (const post of posts) {
    const key = (post.thread as Types.ObjectId).toString();
    if (!map.has(key)) {
      map.set(key, post as PopulatedPost);
    }
  }
  return map;
};

export const forum = async (app: FastifyInstance, config: ViewConfig) => {
  app.get('/category/:id', async (request, reply) => {
    const { id } = request.params as { id: string };

    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const category = await Category.findById(id).lean<CategoryDoc | null>();
    if (!category) {
      return reply.redirect('/');
    }

    const childrenPromise = Category.find({ parent: category._id })
      .sort({ order: 1, name: 1 })
      .lean<CategoryDoc[]>();

    const threadCount = await Thread.countDocuments({ category: category._id });
    const totalPages = Math.max(1, Math.ceil(threadCount / THREADS_PER_PAGE));
    const page = Math.min(
      totalPages,
      currentPage(request.query as { page?: string }),
    );
    const skip = (page - 1) * THREADS_PER_PAGE;

    const threads = await Thread.find({ category: category._id })
      .sort('-createdAt')
      .skip(skip)
      .limit(THREADS_PER_PAGE)
      .populate<{ author: PopulatedAuthor }>('author', 'username')
      .lean();

    const [children, lastPosts] = await Promise.all([
      childrenPromise,
      fetchLastPosts(threads.map((thread) => thread._id)),
    ]);

    const renderedThreads = await Promise.all(
      threads.map(async (thread) => {
        const lastPost = lastPosts.get(thread._id.toString());
        return {
          _id: thread._id,
          title: thread.title,
          locked: thread.locked ?? false,
          authorId: thread.author?._id ?? null,
          authorName: thread.author?.username ?? 'unknown',
          createdAt: thread.createdAt,
          lastPost: lastPost
            ? {
                _id: lastPost._id,
                page: await pageForPost(lastPost),
                authorId: lastPost.author?._id ?? null,
                authorName: lastPost.author?.username ?? 'unknown',
                createdAt: lastPost.createdAt,
              }
            : null,
        };
      }),
    );

    return reply.view('category', {
      ...config,
      category,
      childItems: await buildCategoryItems(children),
      page,
      totalPages,
      basePath: `/category/${category._id}`,
      threads: renderedThreads,
    });
  });

  app.get('/category/:id/create-thread', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const category = await Category.findById(id).lean<CategoryDoc | null>();
    if (!category) {
      return reply.redirect('/');
    }

    return reply.view('create-thread', {
      ...config,
      category,
      error: null,
      title: '',
      content: '',
    });
  });

  app.post('/category/:id/create-thread', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const category = await Category.findById(id).lean<CategoryDoc | null>();
    if (!category) {
      return reply.redirect('/');
    }

    const parseResult = createThreadBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.view('create-thread', {
        ...config,
        category,
        error: parseResult.error.issues[0].message,
        title: (request.body as Record<string, string>)?.title ?? '',
        content: (request.body as Record<string, string>)?.content ?? '',
      });
    }

    const { title, content, processor } = parseResult.data;
    const userId = reply.locals.user.userId;

    const thread = await Thread.create({
      title,
      author: userId,
      category: category._id,
    });

    const post = await Post.create({
      content,
      processor,
      author: userId,
      thread: thread._id,
    });

    thread.lastPost = post._id;
    await thread.save();

    return reply.redirect(`/thread/${thread._id}`);
  });

  app.get('/thread/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const thread = await Thread.findById(id)
      .populate<{ author: PopulatedAuthor }>('author', 'username')
      .populate<{ category: { _id: Types.ObjectId; name: string } }>(
        'category',
        'name',
      )
      .lean();
    if (!thread) {
      return reply.redirect('/');
    }

    const postCount = await Post.countDocuments({ thread: thread._id });
    const totalPages = Math.max(1, Math.ceil(postCount / POSTS_PER_PAGE));
    const page = Math.min(
      totalPages,
      currentPage(request.query as { page?: string }),
    );
    const skip = (page - 1) * POSTS_PER_PAGE;

    const posts = await Post.find({ thread: thread._id })
      .sort('createdAt')
      .skip(skip)
      .limit(POSTS_PER_PAGE)
      .populate<{ author: PopulatedAuthor }>(
        'author',
        'username avatar role signature signatureProcessor',
      )
      .lean();

    return reply.view('thread', {
      ...config,
      thread: {
        _id: thread._id,
        title: thread.title,
        locked: thread.locked ?? false,
        authorId: thread.author?._id ?? null,
        authorName: thread.author?.username ?? 'unknown',
        createdAt: thread.createdAt,
        categoryId: thread.category?._id ?? null,
        categoryName: thread.category?.name ?? 'unknown',
      },
      page,
      totalPages,
      basePath: `/thread/${thread._id}`,
      posts: posts.map((post) => {
        const rendered = renderPost(
          post.content,
          post.processor as 'bbcode' | 'markdown',
        );
        return {
          _id: post._id,
          authorId: post.author?._id ?? null,
          authorName: post.author?.username ?? 'unknown',
          avatarURL: avatarUrlFor(post.author?.avatar),
          role: post.author?.role ?? 'user',
          roleIcon: ROLE_ICONS[post.author?.role ?? 'user'] ?? ROLE_ICONS.user,
          signature: post.author?.signature ?? '',
          signatureProcessor: post.author?.signatureProcessor ?? 'bbcode',
          signatureHtml: renderSignature(
            post.author?.signature ?? '',
            (post.author?.signatureProcessor ?? 'bbcode') as PostProcessor,
          ),
          createdAt: post.createdAt,
          html: rendered,
        };
      }),
    });
  });

  app.post('/thread/:id/lock', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }
    if (!reply.locals.user.isModerator && !reply.locals.user.isAdmin) {
      return reply.redirect('/');
    }

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const thread = await Thread.findById(id);
    if (!thread) {
      return reply.redirect('/');
    }

    thread.locked = !thread.locked;
    await thread.save();

    await logActivity(
      actorFrom(reply.locals.user),
      thread.locked
        ? ACTIVITY_ACTIONS.THREAD_LOCK
        : ACTIVITY_ACTIONS.THREAD_UNLOCK,
      { id: thread._id.toString(), label: thread.title },
    );

    const body = request.body as { page?: string };
    const page = Math.max(1, parseInt(body.page || '1', 10) || 1);
    const pageParam = page > 1 ? `?page=${page}` : '';
    return reply.redirect(`/thread/${thread._id}${pageParam}`);
  });

  app.get('/thread/:id/reply', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const thread = await Thread.findById(id).lean<ThreadDoc | null>();
    if (!thread) {
      return reply.redirect('/');
    }
    if (thread.locked) {
      return reply.redirect(`/thread/${thread._id}`);
    }

    return reply.view('reply', {
      ...config,
      thread: {
        _id: thread._id,
        title: thread.title,
        locked: thread.locked ?? false,
      },
      error: null,
      content: '',
      processor: 'bbcode',
    });
  });

  app.post('/thread/:id/reply', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const thread = await Thread.findById(id);
    if (!thread) {
      return reply.redirect('/');
    }
    if (thread.locked) {
      return reply.redirect(`/thread/${thread._id}`);
    }

    const parseResult = replyBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.view('reply', {
        ...config,
        thread: {
          _id: thread._id,
          title: thread.title,
          locked: thread.locked ?? false,
        },
        error: parseResult.error.issues[0].message,
        content: (request.body as Record<string, string>)?.content ?? '',
        processor:
          (request.body as Record<string, string>)?.processor ?? 'bbcode',
      });
    }

    const { content, processor } = parseResult.data;
    const post = await Post.create({
      content,
      processor,
      author: reply.locals.user.userId,
      thread: thread._id,
    });

    thread.lastPost = post._id;
    await thread.save();

    const page = await lastPageForThread(thread._id);
    return reply.redirect(`/thread/${thread._id}?page=${page}`);
  });

  app.get('/post/:id/edit', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const post = await Post.findById(id)
      .populate<{ author: PopulatedAuthor }>('author', 'username')
      .lean();
    if (!post) {
      return reply.redirect('/');
    }

    const authorId = post.author?._id?.toString();
    const canEdit =
      authorId === reply.locals.user.userId ||
      reply.locals.user.isModerator ||
      reply.locals.user.isAdmin;
    if (!canEdit) {
      return reply.redirect(`/thread/${post.thread}`);
    }

    return reply.view('edit-post', {
      ...config,
      post: {
        _id: post._id,
        threadId: post.thread,
        content: post.content,
        processor: post.processor,
      },
      error: null,
    });
  });

  app.post('/post/:id/edit', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const post = await Post.findById(id).populate<{ author: PopulatedAuthor }>(
      'author',
      'username',
    );
    if (!post) {
      return reply.redirect('/');
    }

    const authorId = post.author?._id?.toString();
    const canEdit =
      authorId === reply.locals.user.userId ||
      reply.locals.user.isModerator ||
      reply.locals.user.isAdmin;
    if (!canEdit) {
      return reply.redirect(`/thread/${post.thread}`);
    }

    const parseResult = editPostBodySchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.view('edit-post', {
        ...config,
        post: {
          _id: post._id,
          threadId: post.thread,
          content: (request.body as Record<string, string>)?.content ?? '',
          processor:
            (request.body as Record<string, string>)?.processor ?? 'bbcode',
        },
        error: parseResult.error.issues[0].message,
      });
    }

    const { content, processor } = parseResult.data;
    post.content = content;
    post.processor = processor;
    await post.save();

    if (
      authorId !== reply.locals.user.userId &&
      (reply.locals.user.isModerator || reply.locals.user.isAdmin)
    ) {
      await logActivity(
        actorFrom(reply.locals.user),
        ACTIVITY_ACTIONS.POST_EDIT,
        {
          id: post._id.toString(),
          label: `Post by ${post.author?.username ?? 'unknown'}`,
        },
      );
    }

    const page = await pageForPost(post);
    return reply.redirect(`/thread/${post.thread}?page=${page}`);
  });

  app.post('/post/:id/delete', async (request, reply) => {
    if (!reply.locals || !reply.locals.user) {
      return reply.redirect('/login');
    }
    if (!reply.locals.user.isModerator && !reply.locals.user.isAdmin) {
      return reply.redirect('/');
    }

    const { id } = request.params as { id: string };
    if (!isValidObjectId(id)) {
      return reply.redirect('/');
    }

    const post = await Post.findById(id).populate<{ author: PopulatedAuthor }>(
      'author',
      'username',
    );
    if (!post) {
      return reply.redirect('/');
    }

    const threadId = post.thread;
    await logActivity(
      actorFrom(reply.locals.user),
      ACTIVITY_ACTIONS.POST_DELETE,
      {
        id: post._id.toString(),
        label: `Post by ${post.author?.username ?? 'unknown'}`,
      },
    );
    await Post.deleteOne({ _id: post._id });
    await updateThreadLastPost(threadId);

    const page = await lastPageForThread(threadId);
    return reply.redirect(`/thread/${threadId}?page=${page}`);
  });
};
