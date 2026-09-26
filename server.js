const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.json': 'application/json; charset=UTF-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

const server = http.createServer((req, res) => {
    let reqPath = req.url.split('?')[0];

    // API Endpoint: Submit Adjustment / Correction Request
    if (req.method === 'POST' && reqPath === '/api/adjustment') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                const payload = JSON.parse(body || '{}');
                const now = new Date();
                const pad = n => String(n).padStart(2, '0');
                const dateCompact = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
                const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
                const timestampStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${timeStr}`;
                const randomSuffix = Math.floor(1000 + Math.random() * 9000);
                const requestId = `REQ-${dateCompact}-${randomSuffix}`;

                const record = {
                    requestId: requestId,
                    timestamp: timestampStr,
                    plant: payload.plant || 'Unknown',
                    shiftType: payload.shiftType || (payload.isOvertime ? 'Overtime' : 'Regular'),
                    targetDate: payload.targetDate || payload.entryDate || `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
                    register: payload.register || payload.registerName || 'General / Not Specified',
                    wrongValue: payload.wrongValue || payload.existingReading || '',
                    correctValue: payload.correctValue || payload.proposedReading || '',
                    reason: payload.reason || payload.comment || 'Correction request',
                    staffName: payload.staffName || 'Operator',
                    phone: payload.phone || payload.contact || 'N/A',
                    status: 'Pending Review',
                    adminRemarks: '',
                    reviewedBy: '',
                    reviewDate: ''
                };

                const recordsFile = path.join(__dirname, 'adjustment_records.json');
                let existing = [];
                if (fs.existsSync(recordsFile)) {
                    try {
                        existing = JSON.parse(fs.readFileSync(recordsFile, 'utf8') || '[]');
                    } catch (e) { existing = []; }
                }
                existing.unshift(record);
                fs.writeFileSync(recordsFile, JSON.stringify(existing, null, 2), 'utf8');

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    requestId: requestId,
                    timestamp: timestampStr,
                    message: `Adjustment request [${requestId}] has been logged in "Adjustment/Correction Record". Central Engineering Admin will review and contact you.`
                }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: err.message }));
            }
        });
        return;
    }

    // API Endpoint: View Adjustment Records
    if (req.method === 'GET' && reqPath === '/api/adjustments') {
        const recordsFile = path.join(__dirname, 'adjustment_records.json');
        let records = [];
        if (fs.existsSync(recordsFile)) {
            try { records = JSON.parse(fs.readFileSync(recordsFile, 'utf8') || '[]'); } catch (e) {}
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, count: records.length, records: records }));
        return;
    }

    if (reqPath === '/' || reqPath === '') {
        reqPath = '/Index.html';
    }

    const filePath = path.join(__dirname, reqPath);

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('404 Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });
});

server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}/`);
});
