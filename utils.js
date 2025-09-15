const axios = require('axios');
const FormData = require('form-data');

/**
 * Parses user input that might use commas, newlines, or both as separators.
 * Also intelligently handles numbers with thousands separators (e.g., "30,000").
 * @param {string} text The raw text input from the user.
 * @returns {string[]} An array of cleaned strings.
 */
function parseInputList(text) {
    const normalizedText = text.replace(/\n/g, ',');
    const dirtyParts = normalizedText.split(',');

    const cleanParts = [];
    for (let i = 0; i < dirtyParts.length; i++) {
        const part = dirtyParts[i].trim();
        if (!part) continue;

        const nextPart = (i + 1 < dirtyParts.length) ? dirtyParts[i + 1].trim() : null;
        if (!isNaN(part) && nextPart && nextPart.length === 3 && !isNaN(nextPart) && part.length <= 3) {
            cleanParts.push(part + nextPart);
            i++; 
        } else {
            cleanParts.push(part);
        }
    }
    return cleanParts.map(p => p.replace(/,/g, ''));
}


/**
 * Uploads an image to ImgBB.
 * @param {object} media The media object from whatsapp-web.js (or a compatible object).
 * @returns {string|null} The display URL of the uploaded image or null on failure.
 */
async function uploadLogo(media) {
    try {
        const imageBuffer = Buffer.from(media.data, 'base64');
        const form = new FormData();
        form.append('image', imageBuffer, { filename: 'logo.png' });

        const response = await axios.post(`https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`, form, {
            headers: form.getHeaders()
        });

        return response.data.data.display_url;
    } catch (error) {
        console.error("ImgBB upload failed:", error.response ? error.response.data : error.message);
        return null;
    }
}


module.exports = {
    parseInputList,
    uploadLogo
};
