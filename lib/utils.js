/**
 * Utility functions for channel operations
 */

/**
 * Calculate the channel index from a channel ID within a list of channels.
 * Channels are sorted by ID (ascending) and the index corresponds to the position in this sorted array.
 * This is used for generating streaming endpoints with consistent indexing.
 * 
 * @param {Array} channels - Array of channel objects with 'id' property
 * @param {number} channelId - The ID of the channel to find the index for
 * @returns {number} The index of the channel in the sorted array, or -1 if not found
 */
function getChannelIndex(channels, channelId) {
    // Sort channels by ID (ascending) - same logic as in setChannelsEndpoints and streaming servers
    const sortedChannels = channels.sort((a, b) => a.id - b.id);
    
    // Find the index of the channel with the given ID
    return sortedChannels.findIndex(channel => channel.id === channelId);
}

/**
 * Get a channel by its index in the sorted channels array.
 * This is the reverse operation of getChannelIndex.
 * 
 * @param {Array} channels - Array of channel objects with 'id' property
 * @param {number} channelIndex - The index in the sorted array
 * @returns {Object|null} The channel object at the given index, or null if not found
 */
function getChannelByIndex(channels, channelIndex) {
    // Sort channels by ID (ascending) - same logic as in streaming servers
    const sortedChannels = channels.sort((a, b) => a.id - b.id);
    
    // Return the channel at the given index
    return sortedChannels[channelIndex] || null;
}

module.exports = {
    getChannelIndex,
    getChannelByIndex
};