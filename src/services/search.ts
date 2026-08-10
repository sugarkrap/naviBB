import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { ViewConfig } from '../views';
import { User } from '../schemas/users';
import { Thread } from '../schemas/threads';
import { Post } from '../schemas/posts';
import { avatarUrlFor } from './auth';
import type { Types } from 'mongoose';

interface SearchResult {
  id: string;
  title: string;
  description: string;
  url: string;
  type: 'user' | 'thread' | 'post';
  authorName?: string;
  authorId?: string;
  avatarURL?: string | null;
  bio?: string;
}

const fuzzyMatch = (query: string, text: string): boolean => {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  let queryIdx = 0;

  for (let i = 0; i < textLower.length && queryIdx < queryLower.length; i++) {
    if (textLower[i] === queryLower[queryIdx]) {
      queryIdx++;
    }
  }

  return queryIdx === queryLower.length;
};

const getMatchScore = (query: string, text: string): number => {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();

  if (textLower === queryLower) return 1000;
  if (textLower.startsWith(queryLower)) return 500;
  if (
    textLower.includes(` ${queryLower}`) ||
    textLower.includes(`-${queryLower}`)
  )
    return 250;

  return 100;
};

const highlightMatch = (query: string, text: string): string => {
  const queryLower = query.toLowerCase();
  const textLower = text.toLowerCase();
  let queryIdx = 0;
  let result = '';

  for (let i = 0; i < text.length; i++) {
    if (queryIdx < queryLower.length && textLower[i] === queryLower[queryIdx]) {
      result += `<span class="search-highlight">${text[i]}</span>`;
      queryIdx++;
    } else {
      result += text[i];
    }
  }

  return result;
};

export const search = async (app: FastifyInstance, config: ViewConfig) => {
  app.get('/search', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = (request.query as { q?: string }).q?.trim() || '';
    const tab = (request.query as { tab?: string }).tab || 'users';
    let users: SearchResult[] = [];
    let threads: SearchResult[] = [];
    let posts: SearchResult[] = [];

    if (query.length >= 2) {
      const userDocs = await User.find(
        {
          $or: [
            { username: { $regex: query, $options: 'i' } },
            { bio: { $regex: query, $options: 'i' } },
          ],
        },
        'username bio avatar',
      )
        .limit(10)
        .lean();

      users = userDocs
        .filter(
          (u) => fuzzyMatch(query, u.username) || fuzzyMatch(query, u.bio),
        )
        .map((u) => ({
          id: (u._id as Types.ObjectId).toString(),
          title: u.username,
          description: '',
          url: `/profile/${(u._id as Types.ObjectId).toString()}`,
          type: 'user' as const,
          avatarURL: avatarUrlFor(u.avatar),
          bio: u.bio || '',
        }))
        .sort((a, b) => {
          const scoreA = getMatchScore(query, a.title);
          const scoreB = getMatchScore(query, b.title);
          return scoreB - scoreA;
        });

      const threadDocs = await Thread.find(
        { title: { $regex: query, $options: 'i' } },
        'title category',
      )
        .populate('author', 'username')
        .limit(10)
        .lean();

      threads = threadDocs
        .filter((t) => fuzzyMatch(query, t.title))
        .map((t) => ({
          id: (t._id as Types.ObjectId).toString(),
          title: t.title,
          description: '',
          url: `/thread/${(t._id as Types.ObjectId).toString()}`,
          type: 'thread' as const,
          authorName: (t.author as any)?.username || 'unknown',
          authorId: ((t.author as any)?._id || '').toString(),
        }))
        .sort((a, b) => {
          const scoreA = getMatchScore(query, a.title);
          const scoreB = getMatchScore(query, b.title);
          return scoreB - scoreA;
        });

      // Search posts
      const postDocs = await Post.find(
        { content: { $regex: query, $options: 'i' } },
        'content thread',
      )
        .populate('thread', 'title _id')
        .populate('author', 'username')
        .limit(10)
        .lean();

      posts = postDocs
        .filter((p) => fuzzyMatch(query, p.content))
        .map((p) => ({
          id: (p._id as Types.ObjectId).toString(),
          title: ((p.thread as any)?.title || 'Untitled thread').substring(
            0,
            50,
          ),
          description:
            p.content.substring(0, 100) + (p.content.length > 100 ? '...' : ''),
          url: `/thread/${((p.thread as any)?._id || 'unknown').toString()}`,
          type: 'post' as const,
          authorName: (p.author as any)?.username || 'unknown',
          authorId: ((p.author as any)?._id || '').toString(),
        }))
        .sort((a, b) => {
          const scoreA = getMatchScore(query, a.description);
          const scoreB = getMatchScore(query, b.description);
          return scoreB - scoreA;
        });
    }

    return reply.view('search', {
      ...config,
      query,
      activeTab: tab,
      users: users.map((u) => ({
        ...u,
        title: highlightMatch(query, u.title),
        bio: u.bio ? highlightMatch(query, u.bio) : '',
      })),
      threads: threads.map((t) => ({
        ...t,
        title: highlightMatch(query, t.title),
      })),
      posts: posts.map((p) => ({
        ...p,
        title: highlightMatch(query, p.title),
        description: highlightMatch(query, p.description),
      })),
      resultCount: users.length + threads.length + posts.length,
    });
  });
};
