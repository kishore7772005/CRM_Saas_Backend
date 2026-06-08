import Role from "../models/role.model.js";

const roleController = {
  //  Create a new role
  createRole: async (req, res) => {
    try {
      const { name, description, permissions } = req.body;

      // Prevent duplicate role names
      const existingRole = await Role.findOne({ name: name.trim() });
      if (existingRole) {
        return res.status(400).json({ message: "Role already exists" });
      }

      //  Normalize permissions: force true/false
      const normalizedPermissions = {};
      if (permissions) {
        Object.keys(permissions).forEach((key) => {
          normalizedPermissions[key] = permissions[key] === true || permissions[key] === "true";
        });
      }

      const role = await Role.create({
        name: name.trim(),
        description,
        permissions: normalizedPermissions,
      });

      res.status(201).json(role);
    } catch (err) {
      console.error("Error creating role:", err);
      res.status(500).json({ message: "Error creating role", error: err.message });
    }
  },

  //  Get all roles with pagination
  getRoles: async (req, res) => {
    try {
      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      const [roles, total] = await Promise.all([
        Role.find().skip(skip).limit(limit),
        Role.countDocuments(),
      ]);

      res.status(200).json({
        roles,
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (err) {
      console.error("Error fetching roles:", err);
      res.status(500).json({ message: "Error fetching roles", error: err.message });
    }
  },

  //  Update a role by ID
  updateRole: async (req, res) => {
    try {
      const { id } = req.params;
      const { name, description, permissions } = req.body;

      const role = await Role.findById(id);
      if (!role) {
        return res.status(404).json({ message: "Role not found" });
      }

      // Update fields if provided
      if (name) role.name = name.trim();
      if (description) role.description = description;

      //  Overwrite permissions correctly
      if (permissions) {
        role.permissions = { ...role.permissions.toObject(), ...permissions };
      }

      const updatedRole = await role.save();

      res.status(200).json(updatedRole);
    } catch (err) {
      console.error("Error updating role:", err);
      res.status(500).json({ message: "Error updating role", error: err.message });
    }
  },

  //  Delete a role by ID
  deleteRole: async (req, res) => {
    try {
      const { id } = req.params;

      const deletedRole = await Role.findByIdAndDelete(id);

      if (!deletedRole) {
        return res.status(404).json({ message: "Role not found" });
      }

      res.status(200).json({ message: "Role deleted successfully" });
    } catch (err) {
      console.error("Error deleting role:", err);
      res.status(500).json({ message: "Error deleting role", error: err.message });
    }
  },
};

export default roleController;