import mongoose from 'mongoose';

export const CategoryGroupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
    },
    order: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true },
);

export const CategoryGroup = mongoose.model(
  'CategoryGroup',
  CategoryGroupSchema,
);
