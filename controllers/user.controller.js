import User from "../models/user.model.js";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import fs from "fs";
import sendEmail from "../utils/sendEmail.js";
import crypto from "crypto";

dotenv.config();
//generat JWT token
const generateToken = (id) =>
  jwt.sign({ id }, process.env.SECRET_KEY, { expiresIn: "1d" });

export default {
  //create new user 
createUser: async (req, res) => {
    console.log("BODY:", req.body);
    console.log("FILE:", req.file);

    try {
      const {
        firstName,
        lastName,
        email,
        password,
        mobileNumber,
        role,
        status,
        gender,
        address,
        dateOfBirth,
      } = req.body;

      //  REMOVED: existingUser duplicate email check
      // Duplicate emails are now allowed

      const profileImage = req.file ? req.file.filename : null;

      const user = await User.create({
        firstName,
        lastName,
        email,
        password,
        mobileNumber,
        role,
        status,
        gender,
        address,
        dateOfBirth,
        profileImage,
      });

      res.status(201).json(user);
    } catch (err) {
      if (req.file) fs.unlinkSync(req.file.path);
      res.status(500).json({ message: err.message });
    }
  },
  //get all users excluding admin
  getUsers: async (req, res) => {
    try {
      // Exclude the seeded admin user from the list
      const users = await User.find({ email: { $ne: "admin@gmail.com" } }).populate("role");

      res.json({
        users,
        total: users.length,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
  //current user profile
  getMe: async (req, res) => {
    try {
      const user = await User.findById(req.user.id).populate("role");

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json({
        _id: user._id,
        name: `${user.firstName} ${user.lastName}`,
        email: user.email,
        profileImage: user.profileImage,
        role: user.role,
      });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
  //update the user details
  updateUser: async (req, res) => {
    try {
      const { id } = req.params;

      const {
        firstName,
        lastName,
        email,
        mobileNumber,
        role,
        status,
        gender,
        address,
        dateOfBirth,
      } = req.body;

      const user = await User.findById(id);
      if (!user) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(404).json({ message: "User not found" });
      }

      //  REMOVED email duplicate check on update too — duplicate emails allowed

      let profileImage = user.profileImage;

      if (req.file) {
        if (user.profileImage) {
          const oldPath = `uploads/users/${user.profileImage}`;
          if (fs.existsSync(oldPath)) {
            fs.unlinkSync(oldPath);
          }
        }
        profileImage = req.file.filename;
      }

      const updatedUser = await User.findByIdAndUpdate(
        id,
        {
          firstName,
          lastName,
          email,
          mobileNumber,
          role,
          status,
          gender,
          address,
          dateOfBirth,
          profileImage,
        },
        { new: true, runValidators: true },
      ).populate("role");

      res.json(updatedUser);
    } catch (err) {
      if (req.file) fs.unlinkSync(req.file.path);
      res.status(500).json({ message: err.message });
    }
  },
  //delete the user
  deleteUser: async (req, res) => {
    try {
      const { id } = req.params;
      const deletedUser = await User.findByIdAndDelete(id);

      if (!deletedUser) {
        return res.status(404).json({ message: "User not found" });
      }

      res.json({ message: "User deleted successfully" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
  //authenticate user, track login history, and return JWT token
  loginUser: async (req, res) => {
  try {

    const { email, password } = req.body;

    const user = await User.findOne({ email })
      .populate("role")
      .select("+password");

    if (!user)
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });

    const isMatch = await user.matchPassword(password);

    if (!isMatch)
      return res.status(401).json({
        success: false,
        message: "Invalid email or password",
      });

    //  Ensure loginHistory exists
    if (!user.loginHistory) {
      user.loginHistory = [];
    }

    // push login entry
    user.loginHistory.push({
      login: new Date(),
    });

    await user.save({ validateBeforeSave: false });

    res.status(200).json({
      success: true,
      message: "Login successful",
      _id: user._id,
      name: `${user.firstName} ${user.lastName}`,
      email: user.email,
      profileImage: user.profileImage,
      role: user.role,
      token: generateToken(user._id),
    });

  }
  catch (error) {

    console.error("Login error:", error);

    res.status(500).json({
      success: false,
      message: error.message,
    });

  }
},
  // Logout user and record logout time in login history
  logoutUser: async (req, res) => {
  try {

    const user = await User.findById(req.user.id);

    if (!user)
      return res.status(404).json({
        message: "User not found"
      });

    if (!user.loginHistory || user.loginHistory.length === 0) {
      return res.json({
        message: "Logout successful"
      });
    }

    const latestEntry = [...user.loginHistory]
      .reverse()
      .find(entry => !entry.logout);

    if (latestEntry) {
      latestEntry.logout = new Date();
      await user.save({ validateBeforeSave: false });
    }

    res.json({
      message: "Logout successful"
    });

  }
  catch (error) {

    console.error(error);

    res.status(500).json({
      message: error.message
    });

  }
},
  // Add this to your existing user controller
  updatePassword: async (req, res) => {
    try {
      const { email, currentPassword, newPassword } = req.body;
      const userId = req.user.id; // From auth middleware

      // Find user
      const user = await User.findById(userId).select("+password");

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Verify email matches
      if (user.email !== email) {
        return res
          .status(400)
          .json({ message: "Email does not match your account" });
      }

      // Verify current password
      if (!(await user.matchPassword(currentPassword))) {
        return res
          .status(401)
          .json({ message: "Current password is incorrect" });
      }

      // Update password
      user.password = newPassword;
      await user.save();

      res.json({ message: "Password updated successfully" });
    } catch (err) {
      res.status(500).json({ message: err.message });
    }
  },
  //forgot Pasword link
  forgotPassword: async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: "Email is required",
      });
    }

    const user = await User.findOne({ email });

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found",
      });
    }

    // Generate reset token
    const resetToken = user.getResetPasswordToken();
    await user.save({ validateBeforeSave: false });

    //   use one FRONTEND_URL
    const frontendUrl = process.env.FRONTEND_URL;

    if (!frontendUrl) {
      return res.status(500).json({
        success: false,
        message: "FRONTEND_URL not configured",
      });
    }

    const resetUrl = `${frontendUrl}/reset-password/${resetToken}`;

    console.log("NODE_ENV:", process.env.NODE_ENV);
    console.log("Reset URL:", resetUrl);

    const message = `
      <h2>Password Reset</h2>
      <p>You requested password reset</p>
      <p>Click below link:</p>
      <a href="${resetUrl}" target="_blank">${resetUrl}</a>
      <p>This link expires in 15 minutes.</p>
    `;

    await sendEmail({
      to: user.email,
      subject: "Password Reset",
      html: message,
    });

    return res.status(200).json({
      success: true,
      message: "Reset link sent successfully",
    });

  } catch (error) {
    console.error(error);

    return res.status(500).json({
      success: false,
      message: "Something went wrong",
    });
  }
},
//reset Password 
resetPassword : async (req, res) =>
{
  try
  {
    const token = req.params.token;

    console.log("Received Token:", token);

    const hashedToken = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    console.log("Hashed Token:", hashedToken);

    const user = await User.findOne({
      resetPasswordToken: hashedToken,
      resetPasswordExpire: { $gt: Date.now() },
    });

    if (!user)
    {
      return res.status(400).json({
        success: false,
        message: "Invalid or expired token",
      });
    }

    user.password = req.body.password;

    user.resetPasswordToken = undefined;
    user.resetPasswordExpire = undefined;

    await user.save();

    res.status(200).json({
      success: true,
      message: "Password reset successful",
    });

  }
  catch (error)
  {
    console.log(error);

    res.status(500).json({
      success: false,
      message: error.message,
    });
  }
},

};