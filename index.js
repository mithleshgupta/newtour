require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const AWS = require('aws-sdk');
const multer = require('multer');
const multerS3 = require('multer-s3');
const AutoIncrement = require('mongoose-sequence')(mongoose); // Import mongoose-sequence

const app = express();
const port = process.env.PORT || 3000; // Set a default port if not provided

app.use(bodyParser.json());
app.use(cors());

AWS.config.update({
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    region: process.env.AWS_REGION,
});

const s3 = new AWS.S3();

const upload = multer({
    storage: multerS3({
        s3: s3,
        bucket: process.env.S3_BUCKET,
        acl: 'public-read',
        metadata: function (req, file, cb) {
            cb(null, { fieldName: file.fieldname });
        },
        key: function (req, file, cb) {
            const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
            cb(null, `tour/${uniqueSuffix}-${file.originalname}`);
        },
    }),
});

app.post('/api/upload', upload.any('images', 10), (req, res) => {
    const fileUrls = req.files.map(file => file.location);
    res.status(200).json({ urls: fileUrls });
});

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
});

app.post('/api/sendOTP', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email address is required' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Your OTP for Verification',
        text: `Your OTP is ${otp}. Use this code to verify your email.`,
    };

    try {
        await transporter.sendMail(mailOptions);

        const token = jwt.sign({ email }, process.env.JWT_SECRET, { expiresIn: '1h' });

        res.status(200).json({ message: 'OTP sent successfully', token });
    } catch (error) {
        console.error('Error sending OTP:', error);
        res.status(500).json({ error: 'Failed to send OTP' });
    }
});

const verifyToken = (req, res, next) => {
    const token = req.headers['authorization'];
    if (!token) return res.status(403).json({ error: 'No token provided' });

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(500).json({ error: 'Failed to authenticate token' });
        req.email = decoded.email;
        next();
    });
};

const mongoURI = process.env.MONGO_URI;
mongoose.connect(mongoURI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
});

const db = mongoose.connection;
db.once('open', () => console.log('Connected to MongoDB'));
db.on('error', (err) => console.error('MongoDB connection error:', err));

const tourSchema = new mongoose.Schema({
    title: String,
    description: String,
    price: Number,
    language: String,
    city: String,
    category: String,
    date: Date,
    timeSlot: String,
    meetingPoint: String,
    images: [String],
    teamMembers: [
        {
            name: String,
            description: String,
            photo: String,
            isLeader: Boolean,
        },
    ],
});

tourSchema.plugin(AutoIncrement, { inc_field: 'tourId' }); // Add auto-incrementing ID field

const Tour = mongoose.model('Tour', tourSchema);

app.post('/api/saveTour', upload.any('images', 20), async (req, res) => {
    try {
        const { title, description, price, language, city, category, date, timeSlot, meetingPoint, teamMembers } = req.body;

        // Separate images into swiper images and team member photos
        const swiperImages = req.files.filter(file => file.fieldname === 'swiperImages').map(file => file.location);
        const teamMemberPhotos = req.files.filter(file => file.fieldname.startsWith('teamMemberPhoto')).map(file => file.location);

        // Parse teamMembers if it is a JSON string
        let parsedTeamMembers = [];
        try {
            parsedTeamMembers = JSON.parse(teamMembers);
        } catch (err) {
            console.error('Error parsing teamMembers:', err);
            return res.status(400).json({ error: 'Invalid teamMembers format' });
        }

        // Construct team members properly and assign photos
        const formattedTeamMembers = parsedTeamMembers.map((member, index) => ({
            name: member.name,
            description: member.description,
            photo: teamMemberPhotos[index] || null,
            isLeader: member.isLeader === 'true',
        }));

        const tour = new Tour({
            title,
            description,
            price,
            language,
            city,
            category,
            date,
            timeSlot,
            meetingPoint,
            images: swiperImages,
            teamMembers: formattedTeamMembers,
        });

        await tour.save();

        res.status(200).json({ message: 'Tour saved successfully' });
    } catch (error) {
        console.error('Error saving tour:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



app.get('/api/getRatings', (req, res) => {
    Tour.find()
        .then(tours => res.json(tours))
        .catch(err => res.status(400).json({ error: err.message }));
});

app.get('/api/getTourTitles', async (req, res) => {
    try {
        const titles = await Tour.find().select('title');
        res.status(200).json(titles);
    } catch (error) {
        console.error('Error fetching tour titles:', error);
        res.status(500).json({ error: 'Failed to fetch tour titles' });
    }
});

app.get('/api/getTourDetails/:tourId', async (req, res) => {
    const { tourId } = req.params;
    try {
        const tour = await Tour.findOne({ tourId: parseInt(tourId, 10) });
        if (!tour) {
            return res.status(404).json({ error: 'Tour not found' });
        }
        res.status(200).json(tour);
    } catch (error) {
        console.error('Error fetching tour details:', error);
        res.status(500).json({ error: 'Failed to fetch tour details' });
    }
});

app.post('/api/updateTour/:tourId', upload.any('images', 20), async (req, res) => {
    const { tourId } = req.params;

    try {
        const { title, description, price, language, city, category, date, timeSlot, meetingPoint, teamMembers } = req.body;

        // Separate images into swiper images and team member photos
        const swiperImages = req.files.filter(file => file.fieldname === 'swiperImages').map(file => file.location);
        const teamMemberPhotos = req.files.filter(file => file.fieldname.startsWith('teamMemberPhoto')).map(file => file.location);

        // Parse teamMembers if it is a JSON string
        let parsedTeamMembers = [];
        try {
            parsedTeamMembers = JSON.parse(teamMembers);
        } catch (err) {
            console.error('Error parsing teamMembers:', err);
            return res.status(400).json({ error: 'Invalid teamMembers format' });
        }

        // Construct team members properly and assign photos
        const formattedTeamMembers = parsedTeamMembers.map((member, index) => ({
            name: member.name,
            description: member.description,
            photo: teamMemberPhotos[index] || null,
            isLeader: member.isLeader === 'true',
        }));

        // Update the tour based on tourId
        const updatedTour = await Tour.findOneAndUpdate(
            { tourId: parseInt(tourId, 10) },
            {
                title,
                description,
                price,
                language,
                city,
                category,
                date,
                timeSlot,
                meetingPoint,
                images: swiperImages,
                teamMembers: formattedTeamMembers,
            },
            { new: true } // Return the updated document
        );

        if (!updatedTour) {
            return res.status(404).json({ error: 'Tour not found' });
        }

        res.status(200).json({ message: 'Tour updated successfully', updatedTour });
    } catch (error) {
        console.error('Error updating tour:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});
