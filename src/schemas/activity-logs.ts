import mongoose from 'mongoose';

export const ActivityLogSchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    actorUsername: { type: String, required: true },
    actorRole: { type: String, enum: ['moderator', 'admin'], required: true },
    action: { type: String, required: true },
    targetId: { type: mongoose.Schema.Types.ObjectId, default: null },
    targetLabel: { type: String, default: '' },
    details: { type: String, default: '' },
  },
  { timestamps: true },
);

export const ActivityLog = mongoose.model('ActivityLog', ActivityLogSchema);
