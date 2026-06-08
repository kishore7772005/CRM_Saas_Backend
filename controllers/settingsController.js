import Settings from "../models/Settings.js";

/**
 * GET SETTINGS
 * Used to fetch current company settings 
 */
export default {

getSettings : async (req, res) => {
  try {
    let settings = await Settings.findOne();

    // If settings does not exist, create default document
    if (!settings) {
      settings = await Settings.create({});
    }

    res.status(200).json(settings);
  } catch (error) {
    console.error("Get Settings Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
},

/**
 * UPDATE COMPANY LOGO
 * Upload image + save path in database
 */
updateLogo : async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Logo file is required" });
    }

    const logoPath = req.file.path.replace(/\\/g, "/"); 

    let settings = await Settings.findOne();

    if (!settings) {
      settings = new Settings({ logo: logoPath });
    } else {
      settings.logo = logoPath;
    }

    await settings.save();

    res.status(200).json({
      success: true,
      message: "Company logo updated successfully",
      data: settings,
    });

  } catch (error) {
    console.error("Update Logo Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
},
/**
 * UPDATE FAVICON
 * Upload favicon + save path in database
 */
updateFavicon : async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "Favicon file is required" });
    }

    const faviconPath = req.file.path.replace(/\\/g, "/");

    let settings = await Settings.findOne();

    if (!settings) {
      settings = new Settings({ favicon: faviconPath });
    } else {
      settings.favicon = faviconPath;
    }

    await settings.save();

    res.status(200).json({
      success: true,
      message: "Favicon updated successfully",
      data: settings,
    });

  } catch (error) {
    console.error("Update Favicon Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
},
/**
 * UPDATE COMPANY NAME (Browser Title)
 */
updateCompanyName : async (req, res) => {
  try {
    const { companyName } = req.body;

    if (!companyName) {
      return res.status(400).json({ message: "Company name is required" });
    }

    let settings = await Settings.findOne();

    if (!settings) {
      settings = new Settings({ companyName });
    } else {
      settings.companyName = companyName;
    }

    await settings.save();

    res.status(200).json({
      success: true,
      message: "Company name updated successfully",
      data: settings,
    });

  } catch (error) {
    console.error("Update Company Name Error:", error);
    res.status(500).json({ message: "Server Error" });
  }
}
};