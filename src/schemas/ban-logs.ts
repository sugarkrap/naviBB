import mongoose from 'mongoose';

export const BanLogSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    bannedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    reason: {
      type: String,
      default: '',
    },
    bannedUntil: {
      type: Date,
      default: null,
    },
    ip: {
      type: String,
      default: null,
    },
    active: {
      type: Boolean,
      default: true,
    },
    unbannedAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

export const BanLog = mongoose.model('BanLog', BanLogSchema);
