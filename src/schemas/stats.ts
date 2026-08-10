import mongoose from 'mongoose';

export const StatsSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  count: {
    type: Number,
    default: 0,
  },
  at: {
    type: Date,
    default: Date.now,
  },
});

export const Stats = mongoose.model('Stats', StatsSchema);
