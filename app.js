const express = require("express");
const multer = require("multer");
const mongoose = require("mongoose");
const cors = require("cors");

const app = express();
const port = 5003;

app.use(cors());

// Connect to MongoDB database
mongoose.connect("mongodb://127.0.0.1:27017/StorageManagement");

mongoose.connection.on("connected", () => {
    console.log("Connected to MongoDB");
});

mongoose.connection.on("error", err => {
    console.error("MongoDB connection error:", err);
});

mongoose.connection.on("disconnected", () => {
    console.log("Disconnected from MongoDB");
});

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const UserSchema = new mongoose.Schema({
    data: Buffer,
    userId: String,
    size: Number,
    allocatedStorage: Number,
    usedStorage: Number,
});

const user_Images = mongoose.model("user_Images", UserSchema);

app.use(express.json());

// Endpoint to allocate storage for a new user
app.post("/api/allocate/:userId", async (req, res) => {
    const userId = req.params.userId;
    try {
        // Check if the user already exists
        const userExists = await user_Images.findOne({ userId: userId });
        if (userExists) {
            return res.status(400).send(`User with ID ${userId} already exists.`);
        }

        // Allocate storage to each user (standard set to 10 MB)
        const allocatedStorage = req.body.allocatedStorage || 10;

        // Create a new user with allocated storage
        const newUser = await user_Images.create({
            userId,
            allocatedStorage,
            usedStorage: 0,
        });

        res.status(201).json({user:newUser});
    } catch (err) {
        console.error(err);
        res.status(500).send("Internal Server Error");
    }
});

// Endpoint to receive and store the image along with userId and calculated size
app.post("/api/uploadImage/:userId", upload.single("image"), async (req, res) => {
    try {
        const userId = req.params.userId;

        const imageSize = req.body.file ? Buffer.byteLength(req.file.buffer) : 0;

        const innerApiResponse = await fetch("http://localhost:3400/api/getBandwidthUsed/${userId}/${imageSize}", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
        });

        const innerApiData = await innerApiResponse.json();

        if (innerApiData && innerApiData.bandwidthAvailable === true) {
            const existingImages = await user_Images.find({ userId: userId });
            const totalSizeOfExistingImages = existingImages.reduce((totalSize, image) => totalSize + image.size, 0);
            const maxAllowedSize = 10485760; // 10MBs
            const eightyPercentOfMaxAllowedSize = 0.8 * maxAllowedSize;

            if (totalSizeOfExistingImages + imageSize <= maxAllowedSize) {
                const newImage = new user_Images({
                    data: req.file.buffer,
                    userId,
                    size: imageSize,
                });

                await newImage.save();

                const updateBandwidthUsage = await fetch("http://localhost:3400/api/updateBandwidthUsed/${userId}/${imageSize}", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                });

                const bandwidthUpdated = await updateBandwidthUsage.json();

                console.log(bandwidthUpdated.db_status);

                const log = await fetch("http://localhost:3004/logs/", {
                    method: "POST",
                    body: JSON.stringify({
                        time: new Date(),
                        size: imageSize,
                        service: "stored",
                        message: "New Image for USER ID: ${userId} saved.",
                    }),
                    headers: { "Content-Type": "application/json" },
                });

                if (totalSizeOfExistingImages + imageSize >= eightyPercentOfMaxAllowedSize) {
                    res.json({ alertMessage: "You have used more than 80 percent of your storage limit!", message: "Image uploaded successfully!" });
                } else {
                    res.json({ alertMessage: "", message: "Image uploaded successfully!" });
                }
            } else {
                console.log("Not enough storage");
                res.status(413).send({ error: "Image not uploaded. Storage limit exceeded." });

                const log = await fetch("http://localhost:3004/logs/", {
                    method: "POST",
                    body: JSON.stringify({
                        time: new Date(),
                        size: imageSize,
                        service: "not stored",
                        message: `New Image for USER ID: ${userId} not saved due to lack of storage`,
                    }),
                    headers: {
                        "Content-Type": "application/json",
                    },
                });
            }
        } else {
            console.log("Not enough bandwidth");
            const message = `Daily bandwidth limit of ${innerApiData.maxBandwidth} bytes exceeded. Upload not possible.`;

            res.status(429).send({ error: "Image not uploaded. Request fulfillment will exceed bandwidth limit.", currentBandwidthUsage: innerApiData.currentBandwidthUsage });

            const log = await fetch("http://localhost:3004/logs/", {
                method: "POST",
                body: JSON.stringify({
                    time: new Date(),
                    size: imageSize,
                    service: "not stored",
                    message: `New Image for USER ID: ${userId} not saved due to bandwidth shortage.`,
                }),
                headers: {
                    "Content-Type": "application/json",
                },
            });
        }
    } catch (error) {
        console.error("Fetch error:", error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Endpoint to delete the image based on imageIds and userId
app.post("/api/deleteImage/:userId", async (req, res) => {
    try {
        const userId = req.params.userId;
        const imageIds = req.body.imageIds;

        if (!Array.isArray(imageIds)) {
            return res.status(400).json({ error: "Invalid imageIds format. Expected an array." });
        }

        for (const imageId of imageIds) {
            const existingImage = await user_Images.findById(imageId);

            if (existingImage && existingImage.userId === userId) {
                const imageSize = existingImage.size;

                const innerApiResponse = await fetch("http://localhost:3400/api/getBandwidthUsed/${userId}/${imageSize}", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                });

                const innerApiData = await innerApiResponse.json();
                const currentBandwidthUsage = innerApiData.currentBandwidthUsage;

                if (innerApiData && innerApiData.bandwidthAvailable === true) {
                    await existingImage.deleteOne();

                    const updateBandwidthUsage = await fetch("http://localhost:3400/api/updateBandwidthUsed/${userId}/${imageSize}", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                        },
                    });

                    const bandwidthUpdated = await updateBandwidthUsage.json();

                    console.log(bandwidthUpdated.db_status);

                    const log = await fetch("http://localhost:3004/logs/", {
                        method: "POST",
                        body: JSON.stringify({
                            time: new Date(),
                            size: imageSize,
                            service: "deleted",
                            message: `Image with ID: ${imageId} for USER ID: ${userId} deleted.`,
                        }),
                        headers: {
                            "Content-Type": "application/json",
                        },
                    });

                    res.json({ message: "Image deleted successfully!" });
                } else {
                    console.log("Not enough bandwidth");
                    res.status(429).send({ error: "Image not deleted. Bandwidth limit exceeded." });

                    const log = await fetch("http://localhost:3004/logs/", {
                        method: "POST",
                        body: JSON.stringify({
                            time: new Date(),
                            size: imageSize,
                            service: "not deleted",
                            message: `Image with ID: ${imageId} for USER ID: ${userId} not deleted due to bandwidth shortage.`,
                        }),
                        headers: {
                            "Content-Type": "application/json",
                        },
                    });
                }
            } else {
                res.json({ message: "Image not found or does not belong to the user." });
            }
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

// Endpoint to alert user when 80% storage is consumed
app.post("/api/alert/:userId", async (req, res) => {
    const userId = req.params.userId;

    try {
        const Images = await user_Images.find({ userId: userId });

        if (!Images.length) {
            res.status(404).json({ message: "User not found" });
            return;
        } else {
            const totalUsedStorage = Images.reduce((sum, user) => sum + user.usedStorage, 0);

            const maxStorageLimitInBytes = Images[0].allocatedStorage * 1024 * 1024;
            const usagePercentage = Math.round((totalUsedStorage / maxStorageLimitInBytes) * 100);
            if (usagePercentage >= 80) {
                res.status(403).json({ error: "You have reached 80% of your capacity!!" });
            } else {
                res.json({ message: "No alert required" });
            }
        }
    } catch (err) {
        console.error(err);
        res.status(500).send(err);
    }
});

app.get("/api/viewGallery/:userId", async (req, res) => {
    try {
        const userId = req.params.userId;
        const Images = await user_Images.find({ userId: userId });

        const imagesWithBase64 = Images.map(image => {
            return {
                _id: image._id,
                data: image.data ? image.data.toString("base64") : null,
            };
        });

        res.status(200).json({ images: imagesWithBase64, Images});
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});
