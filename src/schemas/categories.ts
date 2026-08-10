import mongoose from 'mongoose';

export const CategorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      default: '',
    },
    parent: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
    },
    group: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CategoryGroup',
      default: null,
    },
    logo: {
      type: String,
      default: '',
    },
  },
  { timestamps: true },
);

CategorySchema.index({ parent: 1, name: 1 }, { unique: true });

export const Category = mongoose.model('Category', CategorySchema);
