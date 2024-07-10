const express = require('express');
const router = express.Router();
const multer = require('multer');
const moment = require('moment');
const methodOverride = require('method-override');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Blog = require('../models/Blog');
const Doctor = require('../models/Doctor');
const Admin = require('../models/Admin'); 
const Booking = require('../models/Booking');
const Chat = require('../models/Chat');
const Patient = require('../models/Patient');
const Prescription = require('../models/Prescription');


require('dotenv').config();

console.log('EMAIL_USER:', process.env.EMAIL_USER);
console.log('EMAIL_PASSWORD:', process.env.EMAIL_PASSWORD);

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

router.use(methodOverride('_method'));

function isLoggedIn(req, res, next) {
    if (req.session && req.session.user && req.session.user.role === 'doctor') {
        return next();
    } else {
        console.warn('Unauthorized access attempt:', {
            ip: req.ip,
            originalUrl: req.originalUrl,
            user: req.session.user ? req.session.user.email : 'Guest'
        });
        res.redirect('/auth/login');
    }
}

router.get('/doctor-index', isLoggedIn, async (req, res) => {
    try {
        const doctorEmail = req.session.user.email;

        const doctor = await Doctor.findOne({ email: doctorEmail }).lean();
        if (!doctor) {
            return res.status(404).send('Doctor not found');
        }

        // Fetch only blogs that are verified
        const blogs = await Blog.find({ priority: 'high', verificationStatus: 'Verified' }).limit(5).exec();

        res.render('doctor-index', { doctor, blogs });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


router.get('/profile', isLoggedIn, async (req, res) => {
    try {
      const doctorEmail = req.session.user.email;
      const doctor = await Doctor.findOne({ email: doctorEmail }).lean();
      if (!doctor) {
        return res.status(404).send('Doctor not found');
      }
      res.render('doctorProfile', { doctor });
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  });
  
  router.get('/edit', isLoggedIn, async (req, res) => {
    try {
      const doctorEmail = req.session.user.email;
      const doctor = await Doctor.findOne({ email: doctorEmail }).lean();
  
      if (!doctor.hospitals) {
        doctor.hospitals = [];
      }
  
      res.render('editDoctorProfile', { doctor });
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  });
  
  router.post('/profile/update', upload.single('profilePicture'), isLoggedIn, async (req, res) => {
    try {
      const doctorEmail = req.session.user.email;
      let doctor = await Doctor.findOne({ email: doctorEmail });
  
      let hospitals = [];
      if (Array.isArray(req.body.hospitals)) {
        hospitals = req.body.hospitals.map(hospital => ({
          name: hospital.name,
          street: hospital.street,
          city: hospital.city,
          state: hospital.state,
          country: hospital.country,
          zip: hospital.zip
        }));
      } else if (req.body.hospitals && req.body.hospitals.name) {
        hospitals = [{
          name: req.body.hospitals.name,
          street: req.body.hospitals.street,
          city: req.body.hospitals.city,
          state: req.body.hospitals.state,
          country: req.body.hospitals.country,
          zip: req.body.hospitals.zip
        }];
      }
  
      const updateData = {
        ...req.body,
        speciality: Array.isArray(req.body.speciality) ? req.body.speciality : [req.body.speciality],
        languages: Array.isArray(req.body.languages) ? req.body.languages : [req.body.languages],
        insurances: Array.isArray(req.body.insurances) ? req.body.insurances : [req.body.insurances],
        awards: Array.isArray(req.body.awards) ? req.body.awards : [req.body.awards],
        faqs: Array.isArray(req.body.faqs) ? req.body.faqs : [req.body.faqs],
        hospitals: hospitals
      };
  
      if (req.file) {
        updateData.profilePicture = {
          data: req.file.buffer,
          contentType: req.file.mimetype
        };
      }
  
      doctor = await Doctor.findOneAndUpdate({ email: doctorEmail }, updateData, { new: true });
  
      await doctor.save();
  
      res.redirect('/doctor/profile');
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  });
  
router.post('/profile/verify', isLoggedIn, async (req, res) => {
    try {
        const doctorEmail = req.session.user.email;
        let doctor = await Doctor.findOne({ email: doctorEmail });

        if (!doctor) {
            return res.status(404).send('Doctor not found');
        }

        doctor.verified = 'Pending';
        await doctor.save();

        req.flash('success_msg', 'Verification request sent. You will be notified once verified.');
        res.redirect('/doctor/profile');
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

router.get('/bookings', isLoggedIn, async (req, res) => {
    try {
        const bookings = await Booking.find({ doctor: req.session.user._id }).populate('patient');
        res.render('doctorBookings', { bookings });
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
});

router.post('/bookings/:id', isLoggedIn, async (req, res) => {
    try {
        const { status } = req.body;
        const bookingId = req.params.id;

        const booking = await Booking.findById(bookingId)
            .populate('doctor')
            .populate('patient');

        if (!booking) {
            return res.status(404).send('Booking not found');
        }

        const currentStatus = booking.status;

        const now = moment();

        const bookingDate = moment(booking.date);
        const bookingTimeStart = moment(booking.time.split(' - ')[0], 'HH:mm');
        const bookingTimeEnd = moment(booking.time.split(' - ')[1], 'HH:mm');

        const bookingStartDateTime = moment(bookingDate).set({
            hour: bookingTimeStart.get('hour'),
            minute: bookingTimeStart.get('minute')
        });

        const bookingEndDateTime = moment(bookingDate).set({
            hour: bookingTimeEnd.get('hour'),
            minute: bookingTimeEnd.get('minute')
        });

        if (now.isAfter(bookingEndDateTime)) {
            booking.status = 'completed';
        } else {
            booking.status = status;
        }

        if (status === 'accepted' && !booking.meetingLink && booking.consultationType === 'Video call') {
            booking.meetingLink = await createGoogleMeetLink(booking);
        }

        await booking.save();

        const doctor = booking.doctor;

        if (!doctor) {
            return res.status(404).send('Doctor not found');
        }

        const timeSlotIndex = doctor.timeSlots.findIndex(slot =>
            slot.date.toISOString() === booking.date.toISOString() &&
            slot.startTime === booking.time.split(' - ')[0]
        );

        if (timeSlotIndex !== -1) {
            if (currentStatus === 'rejected' && (status === 'waiting' || status === 'accepted')) {
                doctor.timeSlots[timeSlotIndex].status = 'booked';
            } else if (status === 'rejected') {
                doctor.timeSlots[timeSlotIndex].status = 'free';
            } else {
                doctor.timeSlots[timeSlotIndex].status = 'booked';
            }

            await doctor.save();

            if (status === 'accepted' || status === 'rejected') {
                let emailSubject, emailContent;

                if (status === 'accepted') {
                    if (booking.consultationType === 'Video call') {
                        emailSubject = 'Appointment Confirmation';
                        emailContent = `<p>Dear ${booking.patient.name},</p>
                                        <p>Your appointment with Dr. ${doctor.name} on ${booking.date.toDateString()} at ${booking.time} has been confirmed.</p>
                                        <p>Join the meeting using the following link: <a href="${booking.meetingLink}">${booking.meetingLink}</a></p>
                                        <p>Best regards,</p>
                                        <p>Global Wellness Alliance Team</p>`;
                        await sendAppointmentEmail(booking.patient.email, booking.patient.name, emailSubject, emailContent);

                        const acceptanceEmailContent = `<p>Dear Dr. ${doctor.name},</p>
                                                        <p>The appointment with ${booking.patient.name} on ${booking.date.toDateString()} at ${booking.time} has been confirmed.</p>
                                                        <p>Join the meeting using the following link: <a href="${booking.meetingLink}">${booking.meetingLink}</a></p>
                                                        <p>Best regards,</p>
                                                        <p>Global Wellness Alliance Team</p>`;
                        await sendAppointmentEmail(doctor.email, doctor.name, 'Appointment Confirmation Notification', acceptanceEmailContent);

                        let chatMessage = `Your appointment with Dr. ${doctor.name} on ${booking.date.toDateString()} at ${booking.time} has been confirmed. Join the meeting using the following link: ${booking.meetingLink}`;
                        await Chat.findOneAndUpdate(
                            { doctorId: booking.doctor, patientId: booking.patient },
                            { $push: { messages: { senderId: booking.doctor, text: chatMessage, timestamp: new Date() } } },
                            { upsert: true, new: true }
                        );
                    } else if (booking.consultationType === 'In-person') {
                        emailSubject = 'Appointment Confirmation';
                        emailContent = `<p>Dear ${booking.patient.name},</p>
                                        <p>Your appointment with Dr. ${doctor.name} on ${booking.date.toDateString()} at ${booking.time} has been confirmed.</p>
                                        <p>Please visit the hospital at ${booking.hospital.name}, ${booking.hospital.location.street}, ${booking.hospital.location.city}, ${booking.hospital.location.state}, ${booking.hospital.location.country}, ${booking.hospital.location.zip}</p>
                                        <p>Best regards,</p>
                                        <p>Global Wellness Alliance Team</p>`;
                        await sendAppointmentEmail(booking.patient.email, booking.patient.name, emailSubject, emailContent);

                        let chatMessage = `Your appointment with Dr. ${doctor.name} on ${booking.date.toDateString()} at ${booking.time} has been confirmed. Please visit the hospital at ${booking.hospital.name}, ${booking.hospital.location.street}, ${booking.hospital.location.city}, ${booking.hospital.location.state}, ${booking.hospital.location.country}, ${booking.hospital.location.zip}`;
                        await Chat.findOneAndUpdate(
                            { doctorId: booking.doctor, patientId: booking.patient },
                            { $push: { messages: { senderId: booking.doctor, text: chatMessage, timestamp: new Date() } } },
                            { upsert: true, new: true }
                        );
                    }
                } else if (status === 'rejected') {
                    emailSubject = 'Appointment Rejection';
                    emailContent = `<p>Dear ${booking.patient.name},</p>
                                    <p>We regret to inform you that your appointment with Dr. ${doctor.name} on ${booking.date.toDateString()} at ${booking.time} has been rejected.</p>
                                    <p>Please contact us for further assistance.</p>
                                    <p>Best regards,</p>
                                    <p>Global Wellness Alliance Team</p>`;
                    await sendAppointmentEmail(booking.patient.email, booking.patient.name, emailSubject, emailContent);

                    let chatMessage = `Your appointment with Dr. ${doctor.name} on ${booking.date.toDateString()} at ${booking.time} has been rejected. Please contact us for further assistance.`;
                    await Chat.findOneAndUpdate(
                        { doctorId: booking.doctor, patientId: booking.patient },
                        { $push: { messages: { senderId: booking.doctor, text: chatMessage, timestamp: new Date() } } },
                        { upsert: true, new: true }
                    );
                }
            }
        } else {
            console.error('Time slot not found for the given date and time');
        }

        res.redirect('/doctor/bookings');
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
});


router.get('/completed-bookings', isLoggedIn, async (req, res) => {
    try {
        const doctorId = req.session.user._id; 
        const completedBookings = await Booking.find({ doctor: doctorId, status: 'completed' })
                                               .populate('patient') 
                                               .sort({ date: 'desc' }); 

        res.render('completed-bookings', { bookings: completedBookings });
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
});

router.get('/bookings/:id/prescription', async (req, res) => {
    try {
        const bookingId = req.params.id;
        const booking = await Booking.findById(bookingId).populate('patient').populate('doctor');
        
        if (!booking) {
            return res.status(404).send('Booking not found');
        }

        const patient = booking.patient;
        const doctor = booking.doctor;

        res.render('uploadPrescription', {
            booking,
            patient,
            doctor
        });
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
});

router.post('/prescriptions/upload', async (req, res) => {
    try {
        const { patientId, doctorId, patientName, doctorName, doctorSpeciality, doctorEmail, patientAge, medicines, meetingDate, meetingTime } = req.body;

        const processedMedicines = medicines.map(medicine => ({
            name: medicine.name,
            dosage: medicine.dosage,
            beforeFood: !!medicine.beforeFood,
            afterFood: !!medicine.afterFood,
            timing: {
                morning: !!medicine.timing.morning,
                afternoon: !!medicine.timing.afternoon,
                night: !!medicine.timing.night
            }
        }));

        const prescription = new Prescription({
            patientId,
            doctorId,
            patientName,
            doctorName,
            doctorSpeciality,
            doctorEmail,
            patientAge,
            medicines: processedMedicines,
            meetingDate: new Date(meetingDate),
            meetingTime
        });

        await prescription.save();
        res.redirect('/doctor/completed-bookings');
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
});

router.get('/doctor-view/:id/prescriptions', async (req, res) => {
    try {
        const patientId = req.params.id;
        const prescriptions = await Prescription.find({ patientId }).populate('doctorId').populate('patientId');

        if (!prescriptions) {
            return res.status(404).send('No prescriptions found for this patient');
        }

        res.render('view-prescriptions', {
            prescriptions
        });
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
});

router.get('/manage-time-slots', isLoggedIn, async (req, res) => {
    try {
        const doctorEmail = req.session.user.email;
        const doctor = await Doctor.findOne({ email: doctorEmail }).populate('timeSlots.hospital').exec();
        
        if (!doctor) {
            return res.status(404).send('Doctor not found');
        }
        
        res.render('manageTimeSlots', { doctor });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});


router.delete('/manage-time-slots/:index', isLoggedIn, async (req, res) => {
    try {
        const doctorEmail = req.session.user.email;
        const { index } = req.params;

        let doctor = await Doctor.findOne({ email: doctorEmail });

        if (!doctor) {
            return res.status(404).send('Doctor not found');
        }

        doctor.timeSlots.splice(index, 1); 
        await doctor.save();

        res.redirect('/doctor/manage-time-slots');
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
});

router.post('/add-time-slot', isLoggedIn, async (req, res) => {
    try {
        const doctorEmail = req.session.user.email;
        const { date, startTime, endTime, hospital } = req.body;

        const doctor = await Doctor.findOne({ email: doctorEmail });
        if (!doctor) {
            return res.status(404).send('Doctor not found');
        }

        const selectedHospital = doctor.hospitals.find(h => h.name === hospital);

        if (!selectedHospital) {
            return res.status(404).send('Hospital not found');
        }

        const newTimeSlot = {
            date: new Date(date),
            startTime,
            endTime,
            status: 'free',
            hospital: hospital,
            hospitalLocation: {
                street: selectedHospital.street,
                city: selectedHospital.city,
                state: selectedHospital.state,
                country: selectedHospital.country,
                zip: selectedHospital.zip
            }
        };

        doctor.timeSlots.push(newTimeSlot);
        await doctor.save();

        res.redirect('/doctor/manage-time-slots');
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
});


async function createGoogleMeetLink(booking) {
    const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );

    oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const event = {
        summary: `Appointment with Dr. ${booking.doctor.name}`,
        description: `Appointment with Dr. ${booking.doctor.name} and patient ${booking.patient.name}`,
        start: {
            dateTime: booking.date.toISOString(),
            timeZone: 'America/Los_Angeles',
        },
        end: {
            dateTime: new Date(booking.date.getTime() + 30 * 60000).toISOString(),
            timeZone: 'America/Los_Angeles',
        },
        attendees: [
            { email: booking.doctor.email },
            { email: booking.patient.email },
        ],
        conferenceData: {
            createRequest: {
                requestId: 'some-random-string',
                conferenceSolutionKey: {
                    type: 'hangoutsMeet'
                }
            }
        },
    };

    try {
        const response = await calendar.events.insert({
            calendarId: 'primary',
            resource: event,
            conferenceDataVersion: 1,
        });

        return response.data.hangoutLink;
    } catch (error) {
        console.error('Error creating Google Meet link:', error);
        throw new Error('Unable to create Google Meet link');
    }
}

async function sendAppointmentEmail(to, name, subject, content) {
    const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
        },
    });

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to,
        subject,
        html: content,
    };

    try {
        await transporter.sendMail(mailOptions);
    } catch (error) {
        console.error('Error sending email:', error);
        throw new Error('Unable to send email');
    }
}

router.get('/calendar', isLoggedIn, async (req, res) => {
    try {
        const doctorId = req.session.user._id; 
        const doctor = await Doctor.findById(doctorId);
        if (!doctor) {
            return res.status(404).send('Doctor not found');
        }

        const currentDate = new Date();
        let currentMonth = parseInt(req.query.month) || currentDate.getMonth();
        let currentYear = parseInt(req.query.year) || currentDate.getFullYear();

        if (currentMonth < 0 || currentMonth > 11) {
            currentMonth = currentDate.getMonth();
        }
        if (currentYear < 1900 || currentYear > 2100) {
            currentYear = currentDate.getFullYear();
        }

        const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

        const bookings = await Booking.find({
            doctor: doctorId,
            date: {
                $gte: new Date(currentYear, currentMonth, 1),
                $lte: new Date(currentYear, currentMonth, daysInMonth, 23, 59, 59)
            },
            status: 'accepted'
        });

        const currentTime = {
            hours: currentDate.getHours(),
            minutes: currentDate.getMinutes(),
            seconds: currentDate.getSeconds()
        };

        res.render('doctorCalendar', {
            doctor,
            currentMonth,
            currentYear,
            daysInMonth,
            bookings,
            today: currentDate,
            currentTime, 
            months: [
                'January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December'
            ]
        });
    } catch (error) {
        console.error('Error fetching calendar data:', error);
        res.status(500).send('Server error');
    }
});

router.use(methodOverride('_method'));

router.get('/subscribe', isLoggedIn, async (req, res) => {
    res.render('subscriptionForm');
});

router.post('/subscribe', upload.fields([{ name: 'licenseProof' }, { name: 'certificationProof' }, { name: 'businessProof' }]), isLoggedIn, async (req, res) => {
    try {
    const { subscriptionType } = req.body;
    const paymentDetails = req.body.paymentDetails;
    const doctorId = req.session.user._id; 
    const amount = parseInt(paymentDetails.amount, 10);
    console.log(amount);
    
        if (isNaN(amount) || amount <= 0) {
            return res.status(400).send('Invalid payment amount');
        }
    
        const licenseProof = req.files['licenseProof'][0];
        const certificationProof = req.files['certificationProof'][0];
        const businessProof = req.files['businessProof'][0];
    
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: `${subscriptionType} Subscription`,
                    },
                    unit_amount: amount, 
                },
                quantity: 1,
            }],
            mode: 'payment',
            success_url: `${req.protocol}://${req.get('host')}/doctor/subscription-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${req.protocol}://${req.get('host')}/doctor/subscription-failure`,
        });
    
        req.session.subscriptionInfo = {
            doctorId,
            subscriptionType,
            paymentDetails: {
                amount: amount,
                currency: 'usd'
            },
            licenseProof,
            certificationProof,
            businessProof
        };
    
        res.redirect(303, session.url);
    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
    });
    
router.get('/subscription-success', async (req, res) => {
        try {
            const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
        
            if (session.payment_status === 'paid') {
                const { doctorId, subscriptionType, paymentDetails, licenseProof, certificationProof, businessProof } = req.session.subscriptionInfo;
    
                const paymentDetailsString = JSON.stringify(paymentDetails);
        
                const updatedDoctor = await Doctor.findByIdAndUpdate(
                    doctorId,
                    {
                        subscription: 'Pending',
                        subscriptionType,
                        paymentDetails: paymentDetailsString,
                        'documents.licenseProof': {
                            data: licenseProof.buffer,
                            contentType: licenseProof.mimetype
                        },
                        'documents.certificationProof': {
                            data: certificationProof.buffer,
                            contentType: certificationProof.mimetype
                        },
                        'documents.businessProof': {
                            data: businessProof.buffer,
                            contentType: businessProof.mimetype
                        },
                        subscriptionVerification: 'Pending'
                    },
                    { new: true }
                );
        
                res.render('subscriptionSuccess', { doctor: updatedDoctor });
            } else {
                res.status(400).send('Payment was not successful');
            }
        } catch (error) {
            console.error(error.message);
            res.status(500).send('Server Error');
        }
    });
    

router.get('/subscription-failure', (req, res) => {
    res.send('Subscription payment failed. Please try again.');
});


router.get('/blog', (req, res) => {
    res.render('blog-upload-form'); 
});

router.post('/blog', upload.single('image'), async (req, res) => {
    try {
        const authorEmail = req.session.user.email;
        const { title, author, description, summary, categories, hashtags, priority } = req.body;

        const doctor = await Doctor.findOne({ email: authorEmail });

        let authorId = null;
        if (doctor) {
            authorId = doctor._id; 
        }

        const newBlog = new Blog({
            title,
            author,
            description,
            summary,
            authorEmail,
            authorId, 
            categories: categories, 
            hashtags: hashtags, 
            priority,
            image: {
                data: req.file.buffer,
                contentType: req.file.mimetype
            },
            verificationStatus: 'Pending' 
        });

        await newBlog.save();

        res.render('blog-success', { message: 'Blog uploaded successfully' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Server error' });
    }
});



router.get('/profile/blogs', isLoggedIn, async (req, res) => {
    try {
      const doctorEmail = req.session.user.email; 
  
      const blogs = await Blog.find({ authorEmail: doctorEmail });
  
      res.render('profile-blogs', { blogs });
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  });

router.get('/blogs/edit/:id', isLoggedIn, async (req, res) => {
    try {
      const blog = await Blog.findById(req.params.id);
  
      if (!blog) {
        console.error('Blog not found');
        return res.status(404).send('Blog not found');
      }
  
      if (!req.session.user || !req.session.user._id) {
        console.error('Unauthorized: No user session found');
        return res.status(403).send('Unauthorized');
      }
  
      if (!blog.authorId) {
        console.error('Blog author ID is not defined');
        return res.status(403).send('Unauthorized');
      }
  
      if (blog.authorId.toString() !== req.session.user._id.toString()) {
        return res.status(403).send('Unauthorized');
      }
  
      res.render('edit-blog', { blog });
    } catch (err) {
      console.error(err);
      res.status(500).send('Server Error');
    }
  });
  
  
  

router.post('/blogs/edit/:id', isLoggedIn, upload.single('image'), async (req, res) => {
    try {
        const blog = await Blog.findById(req.params.id);

        if (!blog) {
            return res.status(404).send('Blog not found');
        }

        if (blog.authorId.toString() !== req.session.user._id.toString()) {
            return res.status(403).send('Unauthorized');
        }

        const { title, description, summary, categories, hashtags } = req.body;

        blog.title = title;
        blog.description = description;
        blog.summary = summary;
        blog.categories = categories.split(',');
        blog.hashtags = hashtags.split(',');
     
        blog.verificationStatus = 'pending';

        if (req.file) {
            blog.image.data = req.file.buffer;
            blog.image.contentType = req.file.mimetype;
        }

        await blog.save();

        res.redirect('/doctor/profile/blogs'); 
    } catch (err) {
        console.error(err);
        res.status(500).send('Server Error');
    }
});

router.get('/dashboard', isLoggedIn, async (req, res) => {
    try {
      const doctor = await Doctor.findOne({ email: req.session.user.email }).lean();
      if (!doctor) {
        return res.status(404).send('Doctor not found');
      }
  
      const chats = await Chat.find({ doctorId: doctor._id })
        .populate('patientId', 'name') 
        .sort({ updatedAt: -1 }); 
  
      res.render('doctorDashboard', { doctor, chats });
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  });


  router.post('/chats/:chatId/send-message', isLoggedIn, async (req, res) => {
    try {
        const { message } = req.body;
        const doctor = await Doctor.findOne({ email: req.session.user.email });
        const chatId = req.params.chatId;

        if (!doctor) {
            return res.status(404).send('Doctor not found');
        }

        let chat = await Chat.findOneAndUpdate(
            { _id: chatId, doctorId: doctor._id },
            { $push: { messages: { senderId: doctor._id, text: message, timestamp: new Date() } } },
            { upsert: true, new: true }
        ).populate('patientId');

        if (!chat) {
            return res.status(404).send('Chat not found');
        }

        const consultationType = chat.consultationType;

        let messageContent = '';
        if (consultationType === 'Video call') {
            const booking = {
                doctor: {
                    name: doctor.name,
                    email: doctor.email,
                },
                patient: {
                    name: chat.patientId.name, 
                    email: chat.patientId.email, 
                },
                date: new Date(), 
            };
            
            const videoCallLink = await createGoogleMeetLink(booking);
            console.log(videoCallLink);
            messageContent = `Here is the link to join the video call: ${videoCallLink}`;
        } else if (consultationType === 'In-person') {
            const address = doctor.hospital.address; 
            messageContent = `Your appointment is scheduled at the hospital. Here is the address: ${address}`;
        } else {
            messageContent = `Appointment details: ${consultationType}`;
        }

        chat = await Chat.findByIdAndUpdate(
            chatId,
            { $push: { messages: { senderId: doctor._id, text: messageContent, timestamp: new Date() } } },
            { new: true }
        );

        res.redirect(`/doctor/chat/${chat._id}`);

    } catch (error) {
        console.error(error.message);
        res.status(500).send('Server Error');
    }
});

router.get('/chat/:id', isLoggedIn, async (req, res) => {
    try {
        const chatId = req.params.id;
        const chat = await Chat.findById(chatId).populate('patientId').lean();

        if (!chat) {
            return res.status(404).send('Chat not found');
        }

        res.render('doctorChat', { chat });

    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
});

router.get('/blogs/view/:id', isLoggedIn, async (req, res) => {
    try {
        const blogId = req.params.id;
        const blog = await Blog.findById(blogId).lean();
  
        if (!blog) {
            return res.status(404).send('Blog not found');
        }
  
        res.render('DoctorViewBlog', { blog });
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
  });
  
router.post('/blogs/comment/:id', isLoggedIn, async (req, res) => {
    try {
        const { comment } = req.body;
        const blogId = req.params.id;
        const blog = await Blog.findById(blogId);
  
        if (!blog) {
            return res.status(404).send('Blog not found');
        }
        console.log(req.session.user.name)
        blog.comments.push({
            username: req.session.user.name, 
            comment: comment
        });
  
        await blog.save();
  
        req.flash('success_msg', 'Comment added successfully');
        res.redirect(`/doctor/blogs/view/${blogId}`);
    } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
    }
  });
  
  router.get('/author/:id', async (req, res) => {
    try {
      const authorId = req.params.id;
  
      let author = await Doctor.findById(authorId);
  
      if (!author) {
        author = await Admin.findById(authorId);
      }
  
      if (!author) {
        return res.status(404).send('Author not found');
      }
  
      const blogCount = await Blog.countDocuments({ authorId });
  
      res.render('doctor-author-info', {
        author,
        blogCount
      });
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  });
router.get('/priority-blogs', async (req, res) => {
      try {
        const blogs = await Blog.find({ priority: 'high', verificationStatus: 'Verified' }).lean();
  
        res.render('priorityblogs', { blogs });
      } catch (err) {
        console.error(err.message);
        res.status(500).send('Server Error');
      }
    });
  
router.get('/blogs', async (req, res) => {
    try {
      let filter = { verificationStatus: 'Verified' }; 
  
      if (req.query.search) {
        const regex = new RegExp(escapeRegex(req.query.search), 'gi'); 
  
        filter = {
          verificationStatus: 'Verified',
          $or: [
            { title: regex },
            { categories: regex },
            { hashtags: regex }
          ]
        };
      }
  
      const verifiedBlogs = await Blog.find(filter).lean();
  
      res.render('Doctorblogs', { blogs: verifiedBlogs, searchQuery: req.query.search });
  
    } catch (err) {
      console.error(err.message);
      res.status(500).send('Server Error');
    }
  });

module.exports = router;
