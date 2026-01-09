using System.Collections.Concurrent;
using LiveCaptionsServer.Models;

namespace LiveCaptionsServer.Services;

/// <summary>
/// Interface for the session mapping cache.
/// </summary>
public interface ISessionMappingCache
{
    /// <summary>
    /// Adds or updates a session mapping.
    /// </summary>
    void AddOrUpdate(SessionMapping mapping);

    /// <summary>
    /// Removes a session mapping by session ID.
    /// </summary>
    void Remove(string sessionId);

    /// <summary>
    /// Gets a session mapping by Teams meeting thread ID.
    /// </summary>
    SessionMapping? GetByThreadId(string threadId);

    /// <summary>
    /// Gets a session mapping by session ID.
    /// </summary>
    SessionMapping? GetBySessionId(string sessionId);

    /// <summary>
    /// Gets all active session mappings.
    /// </summary>
    IEnumerable<SessionMapping> GetAll();
}

/// <summary>
/// In-memory cache for session mappings.
/// Thread-safe using ConcurrentDictionary.
/// </summary>
public class SessionMappingCache : ISessionMappingCache
{
    private readonly ConcurrentDictionary<string, SessionMapping> _bySessionId = new();
    private readonly ConcurrentDictionary<string, string> _threadIdToSessionId = new();
    private readonly ILogger<SessionMappingCache> _logger;

    public SessionMappingCache(ILogger<SessionMappingCache> logger)
    {
        _logger = logger;
    }

    /// <inheritdoc/>
    public void AddOrUpdate(SessionMapping mapping)
    {
        if (string.IsNullOrWhiteSpace(mapping.SessionId) || string.IsNullOrWhiteSpace(mapping.ThreadId))
        {
            _logger.LogWarning("[MappingCache] Invalid mapping: SessionId or ThreadId is empty");
            return;
        }

        // If there's an existing mapping with a different threadId, remove the old index
        if (_bySessionId.TryGetValue(mapping.SessionId, out var existingMapping) &&
            existingMapping.ThreadId != mapping.ThreadId)
        {
            _threadIdToSessionId.TryRemove(existingMapping.ThreadId, out _);
        }

        _bySessionId[mapping.SessionId] = mapping;
        _threadIdToSessionId[mapping.ThreadId] = mapping.SessionId;

        _logger.LogInformation("[MappingCache] Added/updated mapping: ThreadId={ThreadId} -> Session={SessionId}, Channel={ChannelId}",
            mapping.ThreadId, mapping.SessionId, mapping.ChannelId);
    }

    /// <inheritdoc/>
    public void Remove(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return;
        }

        if (_bySessionId.TryRemove(sessionId, out var mapping))
        {
            _threadIdToSessionId.TryRemove(mapping.ThreadId, out _);
            _logger.LogInformation("[MappingCache] Removed mapping for session {SessionId} (ThreadId={ThreadId})",
                sessionId, mapping.ThreadId);
        }
    }

    /// <inheritdoc/>
    public SessionMapping? GetByThreadId(string threadId)
    {
        if (string.IsNullOrWhiteSpace(threadId))
        {
            return null;
        }

        if (_threadIdToSessionId.TryGetValue(threadId, out var sessionId))
        {
            if (_bySessionId.TryGetValue(sessionId, out var mapping))
            {
                return mapping;
            }
        }

        return null;
    }

    /// <inheritdoc/>
    public SessionMapping? GetBySessionId(string sessionId)
    {
        if (string.IsNullOrWhiteSpace(sessionId))
        {
            return null;
        }

        _bySessionId.TryGetValue(sessionId, out var mapping);
        return mapping;
    }

    /// <inheritdoc/>
    public IEnumerable<SessionMapping> GetAll()
    {
        return _bySessionId.Values.ToList();
    }
}
