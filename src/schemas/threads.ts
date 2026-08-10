import mongoose from 'mongoose';

export const ThreadSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      default: '',
    },
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    category: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      required: true,
    },
    lastPost: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Post',
      default: null,
    },
    locked: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true },
);

export const Thread = mongoose.model('Thread', ThreadSchema);
