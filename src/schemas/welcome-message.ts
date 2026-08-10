import mongoose from 'mongoose';

// Singleton: at most one document ever exists in this collection.
export const WelcomeMessageSchema = new mongoose.Schema(
  {
    enabled: {
      type: Boolean,
      default: false,
    },
    content: {
      type: String,
      default: '',
    },
    processor: {
      type: String,
      enum: ['bbcode', 'markdown'],
      default: 'bbcode',
    },
  },
  { timestamps: true },
);

export const WelcomeMessage = mongoose.model(
  'WelcomeMessage',
  WelcomeMessageSchema,
);
