import mongoose from 'mongoose';

export const UserSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
    },
    bio: {
      type: String,
      default: '',
      maxlength: 128,
    },
    signature: {
      type: String,
      default: '',
    },
    signatureProcessor: {
      type: String,
      enum: ['bbcode', 'markdown'],
      default: 'bbcode',
    },
    avatar: {
      type: String,
      default: '',
    },
    activationToken: {
      type: String,
      default: '',
    },
    usernameChangedAt: {
      type: Date,
      default: null,
    },
    passwordResetToken: {
      type: String,
      default: '',
    },
    passwordResetExpires: {
      type: Date,
      default: null,
    },
    bannedUntil: {
      type: Date,
      default: null,
    },
    banReason: {
      type: String,
      default: '',
    },
    banIP: {
      type: String,
      default: null,
    },
    lastIP: {
      type: String,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: false,
    },
    role: {
      type: String,
      enum: ['user', 'moderator', 'admin'],
      default: 'user',
    },
    tempPassword: {
      type: String,
      default: null,
    },
    tempPasswordExpires: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true },
);

export const User = mongoose.model('User', UserSchema);
