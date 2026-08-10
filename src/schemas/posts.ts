import mongoose from 'mongoose';

export type PostProcessor = 'bbcode' | 'markdown';

export const PostSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
    },
    processor: {
      type: String,
      enum: ['bbcode', 'markdown'],
      default: 'bbcode',
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    thread: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Thread',
      required: true,
    },
  },
  { timestamps: true },
);

export const Post = mongoose.model('Post', PostSchema);
